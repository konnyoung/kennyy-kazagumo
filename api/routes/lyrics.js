const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { fetchLyrics } = require('../../utils/lyricsManager');

const router = Router();

/**
 * GET /api/lyrics/:guildId
 * Fetches lyrics for the currently playing track via LRClib.
 */
router.get('/:guildId', requireAuth, async (req, res, next) => {
  try {
    const client = req.botClient;
    const player = client.kazagumo.players.get(req.params.guildId);
    if (!player) return res.status(404).json({ error: 'No active player' });

    const track = player.queue.current;
    if (!track) return res.status(404).json({ error: 'No track playing' });

    const result = await fetchLyrics(track);
    if (!result) {
      return res.json({ found: false, title: track.title, artist: track.author });
    }

    res.json({
      found: true,
      title: result.title,
      artist: result.artist,
      lyrics: result.lyrics,
      thumbnail: result.thumbnail,
      source: result.source,
      timedLines: result.timedLines || []
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
