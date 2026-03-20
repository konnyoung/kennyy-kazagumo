const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data', 'playlists');

// Ensure directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function userFile(userId) {
  // Sanitize: only allow digits (Discord IDs are numeric)
  const safe = userId.replace(/\D/g, '');
  if (!safe) throw new Error('Invalid user ID');
  return path.join(DATA_DIR, `${safe}.json`);
}

function readPlaylists(userId) {
  const file = userFile(userId);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

function writePlaylists(userId, playlists) {
  fs.writeFileSync(userFile(userId), JSON.stringify(playlists, null, 2), 'utf-8');
}

function serializeTrack(t) {
  return {
    title: t.title || '',
    author: t.author || '',
    uri: t.uri || '',
    identifier: t.identifier || '',
    length: t.length || 0,
    thumbnail: t.thumbnail || null
  };
}

function listPlaylists(userId) {
  return readPlaylists(userId).map(p => ({
    id: p.id,
    name: p.name,
    image: p.image,
    trackCount: p.tracks.length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }));
}

function getPlaylist(userId, playlistId) {
  return readPlaylists(userId).find(p => p.id === playlistId) || null;
}

function createPlaylist(userId, { name, image }) {
  const playlists = readPlaylists(userId);

  const playlist = {
    id: crypto.randomUUID(),
    name: name || 'Untitled',
    image: image || null,
    tracks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  playlists.push(playlist);
  writePlaylists(userId, playlists);
  return playlist;
}

function updatePlaylist(userId, playlistId, { name, image }) {
  const playlists = readPlaylists(userId);
  const idx = playlists.findIndex(p => p.id === playlistId);
  if (idx === -1) return null;

  if (name !== undefined) playlists[idx].name = name;
  if (image !== undefined) playlists[idx].image = image;
  playlists[idx].updatedAt = new Date().toISOString();

  writePlaylists(userId, playlists);
  return playlists[idx];
}

function deletePlaylist(userId, playlistId) {
  const playlists = readPlaylists(userId);
  const idx = playlists.findIndex(p => p.id === playlistId);
  if (idx === -1) return false;

  playlists.splice(idx, 1);
  writePlaylists(userId, playlists);
  return true;
}

function addTracks(userId, playlistId, tracks) {
  const playlists = readPlaylists(userId);
  const idx = playlists.findIndex(p => p.id === playlistId);
  if (idx === -1) return null;

  const serialized = tracks.map(serializeTrack);
  playlists[idx].tracks.push(...serialized);
  playlists[idx].updatedAt = new Date().toISOString();

  writePlaylists(userId, playlists);
  return playlists[idx];
}

function removeTrack(userId, playlistId, trackIndex) {
  const playlists = readPlaylists(userId);
  const idx = playlists.findIndex(p => p.id === playlistId);
  if (idx === -1) return null;

  if (trackIndex < 0 || trackIndex >= playlists[idx].tracks.length) return null;

  playlists[idx].tracks.splice(trackIndex, 1);
  playlists[idx].updatedAt = new Date().toISOString();

  writePlaylists(userId, playlists);
  return playlists[idx];
}

function exportPlaylist(userId, playlistId) {
  const playlist = getPlaylist(userId, playlistId);
  if (!playlist) return null;
  return {
    _format: 'kennyy-playlist-v1',
    name: playlist.name,
    image: playlist.image,
    tracks: playlist.tracks,
    exportedAt: new Date().toISOString()
  };
}

function importPlaylistData(userId, data) {
  if (!data?.name || !Array.isArray(data.tracks)) return null;

  const playlist = createPlaylist(userId, {
    name: data.name,
    image: data.image || null
  });

  if (data.tracks.length) {
    return addTracks(userId, playlist.id, data.tracks);
  }
  return playlist;
}

module.exports = {
  listPlaylists,
  getPlaylist,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addTracks,
  removeTrack,
  exportPlaylist,
  importPlaylistData
};
