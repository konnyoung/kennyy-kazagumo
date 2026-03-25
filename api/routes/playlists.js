const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const store = require('../../utils/playlistStore');

const router = Router();

/**
 * GET /api/playlists
 * List all playlists for the authenticated user.
 */
router.get('/', requireAuth, (req, res) => {
  res.json({ playlists: store.listPlaylists(req.user.id) });
});

/**
 * GET /api/playlists/:id
 * Get a single playlist with all tracks.
 */
router.get('/:id', requireAuth, (req, res) => {
  const playlist = store.getPlaylist(req.user.id, req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  res.json(playlist);
});

/**
 * POST /api/playlists
 * Create a new playlist.
 * Body: { name: string, image?: string }
 */
router.post('/', requireAuth, (req, res) => {
  const { name, image } = req.body;
  if (!name || typeof name !== 'string' || name.length > 100) {
    return res.status(400).json({ error: 'Name is required (max 100 chars)' });
  }
  if (image && (typeof image !== 'string' || !image.startsWith('http'))) {
    return res.status(400).json({ error: 'Image must be a valid URL' });
  }
  const playlist = store.createPlaylist(req.user.id, { name: name.trim(), image: image || null });
  res.status(201).json(playlist);
});

/**
 * PUT /api/playlists/:id
 * Update playlist name and/or image.
 * Body: { name?: string, image?: string }
 */
router.put('/:id', requireAuth, (req, res) => {
  const { name, image } = req.body;
  if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
    return res.status(400).json({ error: 'Name must be a string (max 100 chars)' });
  }
  if (image !== undefined && image !== null && (typeof image !== 'string' || !image.startsWith('http'))) {
    return res.status(400).json({ error: 'Image must be a valid URL or null' });
  }
  const updated = store.updatePlaylist(req.user.id, req.params.id, {
    name: name?.trim(),
    image
  });
  if (!updated) return res.status(404).json({ error: 'Playlist not found' });
  res.json(updated);
});

/**
 * DELETE /api/playlists/:id
 * Delete a playlist.
 */
router.delete('/:id', requireAuth, (req, res) => {
  const ok = store.deletePlaylist(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ deleted: true });
});

/**
 * POST /api/playlists/:id/tracks
 * Add track(s) to a playlist.
 * Body: { tracks: [{ title, author, uri, identifier, length, thumbnail }] }
 */
router.post('/:id/tracks', requireAuth, (req, res) => {
  const { tracks } = req.body;
  if (!Array.isArray(tracks) || !tracks.length) {
    return res.status(400).json({ error: 'tracks array is required' });
  }
  const updated = store.addTracks(req.user.id, req.params.id, tracks);
  if (!updated) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ trackCount: updated.tracks.length });
});

/**
 * DELETE /api/playlists/:id/tracks/:index
 * Remove a track from a playlist by index.
 */
router.delete('/:id/tracks/:index', requireAuth, (req, res) => {
  const index = parseInt(req.params.index);
  if (isNaN(index) || index < 0) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  const updated = store.removeTrack(req.user.id, req.params.id, index);
  if (!updated) return res.status(404).json({ error: 'Playlist or track not found' });
  res.json({ trackCount: updated.tracks.length });
});

/**
 * POST /api/playlists/:id/import
 * Import tracks from an external URL (Spotify, Deezer, YouTube, etc).
 * Body: { url: string }
 */
router.post('/:id/import', requireAuth, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(400).json({ error: 'A valid URL is required' });
    }

    const playlist = store.getPlaylist(req.user.id, req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const client = req.botClient;
    const result = await client.kazagumo.search(url, {
      requester: { id: req.user.id, username: req.user.username }
    });

    if (!result?.tracks?.length) {
      return res.status(404).json({ error: 'No tracks found from this URL' });
    }

    const tracks = result.tracks.map(t => ({
      title: t.title,
      author: t.author,
      uri: t.uri,
      identifier: t.identifier,
      length: t.length,
      thumbnail: t.thumbnail
    }));

    const updated = store.addTracks(req.user.id, req.params.id, tracks);
    res.json({
      imported: tracks.length,
      playlistName: result.playlistName || null,
      trackCount: updated.tracks.length
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/playlists/:id/play
 * Play (enqueue) all tracks from a saved playlist.
 * Body: { guildId: string, voiceChannelId?: string }
 */
router.post('/:id/play', requireAuth, async (req, res, next) => {
  try {
    const { guildId, voiceChannelId } = req.body;
    if (!guildId) return res.status(400).json({ error: 'guildId is required' });

    const playlist = store.getPlaylist(req.user.id, req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (!playlist.tracks.length) return res.status(400).json({ error: 'Playlist is empty' });

    const client = req.botClient;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    // Resolve voice channel
    let voiceChannel = null;
    const member = guild.members.cache.get(req.user.id) || await guild.members.fetch(req.user.id).catch(() => null);
    if (member) {
      voiceChannel = member.voice?.channel || guild.voiceStates.cache.get(req.user.id)?.channel;
    }
    if (!voiceChannel && voiceChannelId) {
      voiceChannel = guild.channels.cache.get(voiceChannelId);
      if (voiceChannel && voiceChannel.type !== 2) voiceChannel = null;
    }
    if (!voiceChannel) return res.status(400).json({ error: 'You must be in a voice channel or provide voiceChannelId' });

    let player = client.kazagumo.players.get(guild.id);
    if (!player) {
      const preferredNode = client.lavalinkMonitor?.getLeastUsedNodeName?.();
      const opts = {
        guildId: guild.id,
        voiceId: voiceChannel.id,
        textId: null,
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
        } else throw err;
      }
    }

    let added = 0;
    for (const t of playlist.tracks) {
      const searchResult = await client.kazagumo.search(t.uri || `${t.title} ${t.author}`, {
        requester: { id: req.user.id, username: req.user.username }
      });
      if (searchResult?.tracks?.[0]) {
        player.queue.add(searchResult.tracks[0]);
        added++;
      }
    }

    if (!player.playing && !player.paused) {
      await player.play();
    }

    res.json({ added, queueLength: player.queue.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/playlists/:id/play-from
 * Play a specific track from a saved playlist.
 * - If queue has tracks from multiple users: just adds to queue (returns mode: 'queued')
 * - Otherwise: clears queue, plays selected track, enqueues rest of playlist (returns mode: 'replaced')
 * Body: { guildId: string, trackIndex: number, voiceChannelId?: string }
 */
router.post('/:id/play-from', requireAuth, async (req, res, next) => {
  try {
    const { guildId, trackIndex, voiceChannelId } = req.body;
    if (!guildId) return res.status(400).json({ error: 'guildId is required' });
    if (typeof trackIndex !== 'number' || trackIndex < 0) {
      return res.status(400).json({ error: 'trackIndex is required' });
    }

    const playlist = store.getPlaylist(req.user.id, req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (trackIndex >= playlist.tracks.length) {
      return res.status(400).json({ error: 'trackIndex out of range' });
    }

    const client = req.botClient;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    // Resolve voice channel
    let voiceChannel = null;
    const member = guild.members.cache.get(req.user.id) || await guild.members.fetch(req.user.id).catch(() => null);
    if (member) {
      voiceChannel = member.voice?.channel || guild.voiceStates.cache.get(req.user.id)?.channel;
    }
    if (!voiceChannel && voiceChannelId) {
      voiceChannel = guild.channels.cache.get(voiceChannelId);
      if (voiceChannel && voiceChannel.type !== 2) voiceChannel = null;
    }
    if (!voiceChannel) return res.status(400).json({ error: 'You must be in a voice channel or provide voiceChannelId' });

    let player = client.kazagumo.players.get(guild.id);
    if (!player) {
      const preferredNode = client.lavalinkMonitor?.getLeastUsedNodeName?.();
      const opts = {
        guildId: guild.id,
        voiceId: voiceChannel.id,
        textId: null,
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
        } else throw err;
      }
    }

    // Check if queue has multiple unique requesters
    const requesters = new Set();
    if (player.queue.current?.requester?.id) requesters.add(player.queue.current.requester.id);
    for (const t of player.queue) {
      if (t.requester?.id) requesters.add(t.requester.id);
    }
    const isMultiUser = requesters.size > 1;

    const requesterObj = { id: req.user.id, username: req.user.username };

    if (isMultiUser) {
      // Multi-user queue: just add the clicked track to queue
      const t = playlist.tracks[trackIndex];
      const searchResult = await client.kazagumo.search(t.uri || `${t.title} ${t.author}`, { requester: requesterObj });
      if (searchResult?.tracks?.[0]) {
        player.queue.add(searchResult.tracks[0]);
      }
      if (!player.playing && !player.paused) await player.play();
      return res.json({ mode: 'queued', added: 1, queueLength: player.queue.length });
    }

    // Single-user or empty: clear and play from the selected track, then enqueue rest
    player.queue.clear();

    // Order: selected track first, then tracks after it, then tracks before it
    const ordered = [
      ...playlist.tracks.slice(trackIndex),
      ...playlist.tracks.slice(0, trackIndex)
    ];

    let added = 0;
    for (const t of ordered) {
      const searchResult = await client.kazagumo.search(t.uri || `${t.title} ${t.author}`, { requester: requesterObj });
      if (searchResult?.tracks?.[0]) {
        player.queue.add(searchResult.tracks[0]);
        added++;
      }
    }

    // Skip current track to start playing from our first added track
    if (player.playing || player.paused) {
      await player.skip();
    } else {
      await player.play();
    }

    res.json({ mode: 'replaced', added, queueLength: player.queue.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/playlists/:id/export
 * Export a playlist as portable JSON.
 */
router.get('/:id/export', requireAuth, (req, res) => {
  const data = store.exportPlaylist(req.user.id, req.params.id);
  if (!data) return res.status(404).json({ error: 'Playlist not found' });
  res.json(data);
});

/**
 * POST /api/playlists/import-file
 * Import from a previously exported JSON file.
 * Body: { _format, name, image, tracks }
 */
router.post('/import-file', requireAuth, (req, res) => {
  const data = req.body;
  if (data?._format !== 'kennyy-playlist-v1') {
    return res.status(400).json({ error: 'Invalid playlist file format' });
  }
  const playlist = store.importPlaylistData(req.user.id, data);
  if (!playlist) return res.status(400).json({ error: 'Failed to import playlist' });
  res.status(201).json(playlist);
});

module.exports = router;
