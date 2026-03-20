const { Router } = require('express');
const { requireAuth, requireVoice, requirePermission } = require('../middleware/auth');

const router = Router();

function serializeTrack(track, index) {
  if (!track) return null;
  return {
    index,
    title: track.title,
    author: track.author,
    uri: track.uri,
    identifier: track.identifier,
    length: track.length,
    thumbnail: track.thumbnail,
    requester: track.requester ? {
      id: track.requester.id,
      username: track.requester.username
    } : null
  };
}

/**
 * GET /api/queue/:guildId
 * Returns the current queue with the currently playing track.
 */
router.get('/:guildId', requireAuth, (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.json({ current: null, tracks: [], length: 0 });

  const current = player.queue.current ? serializeTrack(player.queue.current, -1) : null;
  const tracks = Array.from(player.queue).map((t, i) => serializeTrack(t, i));

  res.json({
    current,
    tracks,
    length: player.queue.length,
    loop: player.loop,
    position: player.position
  });
});

/**
 * DELETE /api/queue/:guildId
 * Clears the queue (keeps current track playing).
 */
router.delete('/:guildId', requireAuth, requireVoice, requirePermission('controlPlayer'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  player.queue.clear();
  res.json({ cleared: true, length: 0 });
});

/**
 * DELETE /api/queue/:guildId/:index
 * Removes a specific track from the queue by index.
 */
router.delete('/:guildId/:index', requireAuth, requireVoice, requirePermission('removeTracks'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  const index = parseInt(req.params.index);
  if (isNaN(index) || index < 0 || index >= player.queue.length) {
    return res.status(400).json({ error: 'Invalid index' });
  }

  const removed = player.queue.splice(index, 1);
  res.json({
    removed: removed.length ? serializeTrack(removed[0], index) : null,
    length: player.queue.length
  });
});

/**
 * POST /api/queue/:guildId/shuffle
 * Shuffles the queue.
 */
router.post('/:guildId/shuffle', requireAuth, requireVoice, requirePermission('reorderQueue'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  player.queue.shuffle();
  const tracks = Array.from(player.queue).map((t, i) => serializeTrack(t, i));
  res.json({ shuffled: true, tracks, length: player.queue.length });
});

/**
 * POST /api/queue/:guildId/skipto
 * Body: { index: number }
 * Skips to a specific track in the queue.
 */
router.post('/:guildId/skipto', requireAuth, requireVoice, requirePermission('controlPlayer'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  const { index } = req.body;
  if (typeof index !== 'number' || index < 0 || index >= player.queue.length) {
    return res.status(400).json({ error: 'Invalid index' });
  }

  // Remove tracks before the target index
  player.queue.splice(0, index);
  player.skip();

  res.json({ skippedTo: index });
});

/**
 * POST /api/queue/:guildId/move
 * Body: { from: number, to: number }
 * Moves a track from one position to another in the queue.
 */
router.post('/:guildId/move', requireAuth, requireVoice, requirePermission('reorderQueue'), (req, res) => {
  const player = req.botClient.kazagumo.players.get(req.params.guildId);
  if (!player) return res.status(404).json({ error: 'No active player' });

  const { from, to } = req.body;
  if (typeof from !== 'number' || typeof to !== 'number' ||
      from < 0 || from >= player.queue.length ||
      to < 0 || to >= player.queue.length || from === to) {
    return res.status(400).json({ error: 'Invalid from/to index' });
  }

  const [track] = player.queue.splice(from, 1);
  player.queue.splice(to, 0, track);

  const tracks = Array.from(player.queue).map((t, i) => serializeTrack(t, i));
  res.json({ moved: true, tracks, length: player.queue.length });
});

module.exports = router;
