const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

const router = Router();

function serializeTrack(track) {
  if (!track) return null;
  return {
    title: track.title,
    author: track.author,
    uri: track.uri,
    identifier: track.identifier,
    length: track.length,
    thumbnail: track.thumbnail
  };
}

/**
 * GET /api/search?q=query&source=spotify|youtube
 * Searches for tracks without playing them.
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { q, source } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

    const client = req.botClient;
    const isUrl = /^https?:\/\//.test(q);
    const searchOpts = { requester: { id: req.user.id, username: req.user.username } };

    if (!isUrl) {
      switch (source) {
        case 'youtube': searchOpts.source = 'ytsearch:'; break;
        case 'soundcloud': searchOpts.source = 'scsearch:'; break;
        default: searchOpts.source = 'spsearch:'; break;
      }
    }

    const result = await client.kazagumo.search(q, searchOpts);

    if (!result?.tracks?.length) {
      return res.json({ tracks: [], type: null, playlistName: null });
    }

    res.json({
      tracks: result.tracks.slice(0, 25).map(serializeTrack),
      type: result.type,
      playlistName: result.playlistName || null,
      playlistThumbnail: result.type === 'PLAYLIST' ? (result.tracks[0]?.thumbnail || null) : null,
      totalTracks: result.type === 'PLAYLIST' ? result.tracks.length : null
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
