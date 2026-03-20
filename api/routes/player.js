const { Router } = require('express');
const { requireAuth, requireVoice, requirePermission } = require('../middleware/auth');
const { logSiteNowPlaying } = require('../../utils/webhookLogger');
const sessionStore = require('../../utils/sessionStore');

const router = Router();

/**
 * Serialize a KazagumoTrack to a plain object.
 */
function serializeTrack(track) {
  if (!track) return null;
  return {
    title: track.title,
    author: track.author,
    uri: track.uri,
    identifier: track.identifier,
    length: track.length,
    thumbnail: track.thumbnail,
    requester: track.requester ? {
      id: track.requester.id,
      username: track.requester.username,
      avatar: track.requester.displayAvatarURL?.({ size: 64 }) || null
    } : null
  };
}

/**
 * GET /api/player/:guildId
 * Returns current player state (playing, paused, track, position, volume, loop).
 */
router.get('/:guildId', requireAuth, (req, res) => {
  const client = req.botClient;
  const player = client.kazagumo.players.get(req.params.guildId);

  if (!player) {
    return res.json({ active: false });
  }

  res.json({
    active: true,
    playing: player.playing,
    paused: player.paused,
    volume: player.volume,
    position: player.position,
    loop: player.loop,
    voiceId: player.voiceId,
    current: serializeTrack(player.queue.current),
    queueLength: player.queue.length
  });
});

/**
 * POST /api/player/:guildId/play
 * Body: { query: string }
 * Searches and plays a track (or adds to queue if already playing).
 */
router.post('/:guildId/play', requireAuth, requireVoice, requirePermission('addTracks'), async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const client = req.botClient;
    const guild = req.guild;
    const voiceChannel = req.voiceChannel;

    let player = client.kazagumo.players.get(guild.id);

    if (!player) {
      const preferredNode = client.lavalinkMonitor?.getLeastUsedNodeName?.();
      const opts = {
        guildId: guild.id,
        voiceId: voiceChannel.id,
        textId: null, // no text channel for API-initiated playback
        deaf: true,
        volume: 100
      };
      if (preferredNode) opts.nodeName = preferredNode;

      try {
        player = await client.kazagumo.createPlayer(opts);
      } catch (err) {
        if (preferredNode) {
          delete opts.nodeName;
          player = await client.kazagumo.createPlayer(opts);
        } else {
          throw err;
        }
      }
    }

    // First user to play (regardless of whether the player already existed) becomes admin
    sessionStore.setAdminIfNone(guild.id, req.user.id);

    const isUrl = /^https?:\/\//.test(query);
    const searchOpts = { requester: { id: req.user.id, username: req.user.username } };
    if (!isUrl) searchOpts.source = 'spsearch:';

    const result = await client.kazagumo.search(query, searchOpts);

    if (!result?.tracks?.length) {
      return res.status(404).json({ error: 'No results found' });
    }

    const forcePlay = req.body.forcePlay === true;
    const added = [];
    if (result.type === 'PLAYLIST') {
      for (const track of result.tracks) {
        player.queue.add(track);
        added.push(serializeTrack(track));
      }
    } else {
      const track = result.tracks[0];
      if (forcePlay && (player.playing || player.paused)) {
        player.queue.add(track, 0);
        player.skip();
      } else {
        player.queue.add(track);
      }
      added.push(serializeTrack(track));
    }

    if (!player.playing && !player.paused) {
      await player.play();
    }

    // Log the first added track to the site webhook
    const firstTrack = added[0];
    if (firstTrack) {
      const guildName = guild?.name || req.params.guildId;
      logSiteNowPlaying(firstTrack, req.user, guildName).catch(() => {});
    }

    res.json({
      added,
      playlistName: result.playlistName || null,
      queueLength: player.queue.length,
      playing: player.playing
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/player/:guildId/pause
 */
router.post('/:guildId/pause', requireAuth, requireVoice, requirePermission('controlPlayer'), async (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  await player.pause(true);
  res.json({ paused: true });
});

/**
 * POST /api/player/:guildId/resume
 */
router.post('/:guildId/resume', requireAuth, requireVoice, requirePermission('controlPlayer'), async (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  await player.pause(false);
  res.json({ paused: false });
});

/**
 * POST /api/player/:guildId/skip
 */
router.post('/:guildId/skip', requireAuth, requireVoice, requirePermission('controlPlayer'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  player.skip();
  res.json({ skipped: true });
});

/**
 * POST /api/player/:guildId/stop
 * Clears the queue and destroys the player.
 */
router.post('/:guildId/stop', requireAuth, requireVoice, requirePermission('controlPlayer'), async (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  try {
    player.queue.clear();
    await player.destroy();
  } catch (err) {
    // Se destroy falhar (ex: Forbidden), força remoção para evitar ghost player
    req.botClient.kazagumo.players.delete(req.params.guildId);
  }
  res.json({ stopped: true });
});

/**
 * POST /api/player/:guildId/seek
 * Body: { position: number } (milliseconds)
 */
router.post('/:guildId/seek', requireAuth, requireVoice, requirePermission('controlPlayer'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  const { position } = req.body;
  if (typeof position !== 'number' || position < 0) {
    return res.status(400).json({ error: 'Invalid position' });
  }

  player.seek(position);
  res.json({ position });
});

/**
 * POST /api/player/:guildId/volume
 * Body: { volume: number } (0-150)
 */
router.post('/:guildId/volume', requireAuth, requireVoice, requirePermission('controlPlayer'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  const { volume } = req.body;
  if (typeof volume !== 'number' || volume < 0 || volume > 150) {
    return res.status(400).json({ error: 'Volume must be between 0 and 150' });
  }

  player.setVolume(volume);
  res.json({ volume });
});

/**
 * POST /api/player/:guildId/loop
 * Body: { mode: 'none' | 'track' | 'queue' }
 */
router.post('/:guildId/loop', requireAuth, requireVoice, requirePermission('controlPlayer'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  const { mode } = req.body;
  if (!['none', 'track', 'queue'].includes(mode)) {
    return res.status(400).json({ error: "Mode must be 'none', 'track', or 'queue'" });
  }

  player.setLoop(mode);
  res.json({ loop: mode });
});

module.exports = router;
