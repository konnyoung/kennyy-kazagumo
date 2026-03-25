const LRCLIB_API_BASE = 'https://lrclib.net/api';
const TIMESTAMP_REGEX = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
const DEFAULT_POSITION_SKEW_MS = 300;

function getApproxPositionMs(player, track) {
  if (!player) return 0;
  const rawPosition = player.position || 0;
  const durationMs = track?.duration ?? track?.length ?? null;
  const isPaused = Boolean(player.paused);

  if (isPaused) {
    return clampDuration(rawPosition + DEFAULT_POSITION_SKEW_MS, durationMs);
  }

  const now = Date.now();
  const last = player.data?.get?.('lyricsPos');

  // Reset baseline when Kazagumo reports a new position value
  if (!last || last.base !== rawPosition) {
    player.data?.set?.('lyricsPos', { base: rawPosition, ts: now });
    return clampDuration(rawPosition + DEFAULT_POSITION_SKEW_MS, durationMs);
  }

  // Interpolate: base + time elapsed since last position update + lookahead
  const elapsed = now - last.ts;
  const approx = rawPosition + elapsed + DEFAULT_POSITION_SKEW_MS;
  return clampDuration(approx, durationMs);
}

async function fetchLyrics(track) {
  if (!track) return null;

  let payload = null;

  const isrc = extractTrackISRC(track);
  if (isrc) {
    payload = await lrclibRequest('get', { isrc });
  }

  if (!payload) {
    const queries = buildLRClibQueries(track);
    for (const params of queries) {
      const results = await lrclibRequest('search', params);
      if (!Array.isArray(results)) continue;
      payload = selectLRClibResult(results, track);
      if (payload) break;
    }
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const timedLines = parseSyncedLyrics(payload.syncedLyrics, track.length);
  
  let cleanedText = payload.plainLyrics ? cleanLyricsText(payload.plainLyrics) : null;
  if (!cleanedText && timedLines.length > 0) {
    const collected = timedLines.map(entry => (entry.line || '').trim()).filter(Boolean);
    cleanedText = collected.join('\n') || null;
  }

  if (!cleanedText && timedLines.length === 0) {
    return null;
  }

  const language = payload.language;
  const sourceHint = payload.syncedLyricsSource || payload.plainLyricsSource || 'LRCLib';
  const sourceLabel = language ? `${sourceHint} [${language}]` : sourceHint;

  return {
    title: payload.trackName || track.title,
    artist: payload.artistName || track.author,
    lyrics: cleanedText || '',
    thumbnail: track.thumbnail || track.artworkUrl || null,
    url: track.uri || track.realUri || null,
    source: sourceLabel,
    timedLines
  };
}

async function lrclibRequest(endpoint, params) {
  const url = `${LRCLIB_API_BASE}/${endpoint}`;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      searchParams.append(key, String(value));
    }
  }

  try {
    const response = await fetch(`${url}?${searchParams.toString()}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'KennyMusicBot/1.0 (+https://github.com/)'
      },
      signal: AbortSignal.timeout(12000)
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      console.log(`[Lyrics] LRCLib request failed (${response.status}): ${body.substring(0, 200)}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      console.log(`[Lyrics] Timeout querying LRCLib at ${endpoint}`);
    } else {
      console.log(`[Lyrics] Error querying LRCLib: ${error.message}`);
    }
    return null;
  }
}

function buildLRClibQueries(track) {
  const title = (track.title || '').trim();
  const artist = (track.author || '').trim();
  const durationMs = track.duration || track.length || 0;
  const durationSeconds = durationMs > 0 ? Math.round(durationMs / 1000) : null;

  const queries = [];
  const seen = new Set();

  function addQuery(trackName, artistName) {
    const key = `${trackName}|${artistName}|${durationSeconds}`;
    if (seen.has(key)) return;
    seen.add(key);

    const payload = {
      track_name: trackName,
      artist_name: artistName
    };

    if (durationSeconds) {
      payload.duration = durationSeconds;
    }

    queries.push(payload);
  }

  addQuery(title, artist);

  const normalizedTitle = sanitizeMetadata(title);
  const normalizedArtist = sanitizeMetadata(artist);
  addQuery(normalizedTitle, normalizedArtist);

  const altArtist = stripFeatureCredit(normalizedArtist);
  if (altArtist !== normalizedArtist) {
    addQuery(normalizedTitle, altArtist);
  }

  if (normalizedTitle.includes(' - ')) {
    const mainTitle = normalizedTitle.split(' - ')[0].trim();
    addQuery(mainTitle, altArtist);
  }

  addQuery(normalizedTitle, '');

  return queries;
}

function selectLRClibResult(results, track) {
  const valid = results.filter(entry => {
    if (typeof entry !== 'object' || !entry) return false;
    return entry.syncedLyrics || entry.plainLyrics;
  });

  if (valid.length === 0) return null;

  const titleTarget = (track.title || '').toLowerCase();
  const artistTarget = (track.author || '').toLowerCase();
  const durationMs = track.duration || track.length || 0;
  const durationTarget = durationMs > 0 ? Math.round(durationMs / 1000) : null;

  for (const entry of valid) {
    const entryTitle = String(entry.trackName || '').toLowerCase();
    const entryArtist = String(entry.artistName || '').toLowerCase();
    
    if (entryTitle === titleTarget && (!artistTarget || artistTarget.includes(entryArtist) || entryArtist.includes(artistTarget))) {
      return entry;
    }
  }

  if (durationTarget !== null) {
    valid.sort((a, b) => {
      const aDuration = parseInt(a.duration) || durationTarget;
      const bDuration = parseInt(b.duration) || durationTarget;
      return Math.abs(durationTarget - aDuration) - Math.abs(durationTarget - bDuration);
    });
  }

  return valid[0];
}

function parseSyncedLyrics(synced, trackLengthMs) {
  if (!synced || typeof synced !== 'string') return [];

  const timedEntries = [];
  const lines = synced.split('\n');

  for (const rawLine of lines) {
    const matches = [...rawLine.matchAll(TIMESTAMP_REGEX)];
    if (matches.length === 0) continue;

    const lyricText = rawLine.replace(TIMESTAMP_REGEX, '').trim();
    if (!lyricText) continue;

    for (const match of matches) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const fraction = (match[3] || '0').substring(0, 3).padEnd(3, '0');
      const millis = parseInt(fraction, 10);

      const timestamp = minutes * 60000 + seconds * 1000 + millis;
      timedEntries.push({
        timestamp,
        line: lyricText
      });
    }
  }

  timedEntries.sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 0; i < timedEntries.length; i++) {
    const entry = timedEntries[i];
    let nextTimestamp = null;

    if (i + 1 < timedEntries.length) {
      nextTimestamp = timedEntries[i + 1].timestamp;
    } else if (typeof trackLengthMs === 'number' && trackLengthMs > entry.timestamp) {
      nextTimestamp = trackLengthMs;
    }

    if (nextTimestamp !== null) {
      entry.duration = Math.max(0, nextTimestamp - entry.timestamp);
    } else {
      entry.duration = null;
    }
  }

  return timedEntries;
}

function clampDuration(value, durationMs) {
  if (durationMs == null) return value;
  return Math.min(Math.max(0, value), durationMs);
}

function extractTrackISRC(track) {
  if (track.isrc && typeof track.isrc === 'string' && track.isrc.trim()) {
    return track.isrc.trim();
  }

  const info = track.info;
  if (info && typeof info === 'object') {
    const candidate = info.isrc || info.isrcCode;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function sanitizeMetadata(value) {
  if (!value) return '';
  let cleaned = value.replace(/\s*\([^)]*\)/g, '');
  cleaned = cleaned.replace(/\s*\[[^\]]*\]/g, '');
  cleaned = cleaned.replace(/\s*\{[^}]*\}/g, '');
  cleaned = cleaned.replace(/–/g, '-');
  return cleaned.trim();
}

function stripFeatureCredit(artist) {
  if (!artist) return '';
  const parts = artist.split(/\s+(?:feat\.|featuring|ft\.)\s+/i);
  return parts[0].trim();
}

function cleanLyricsText(text) {
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  const lines = normalized.split('\n').map(line => line.trimEnd());
  const cleanedLines = lines.filter(line => line.trim());
  return cleanedLines.join('\n').trim();
}

function findLineIndex(lines, positionMs) {
  if (!lines || lines.length === 0) return null;

  let index = null;
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    if (typeof entry.timestamp !== 'number') continue;

    if (positionMs >= entry.timestamp) {
      index = i;
    } else {
      break;
    }
  }

  if (index === null && typeof lines[0].timestamp === 'number' && positionMs < lines[0].timestamp) {
    return 0;
  }

  return index;
}

function renderTimedSnippet(lines, currentIndex, window = 2) {
  if (!lines || lines.length === 0) return null;

  if (currentIndex === null || currentIndex === undefined) {
    currentIndex = 0;
  }

  currentIndex = Math.max(0, Math.min(currentIndex, lines.length - 1));
  const start = Math.max(0, currentIndex - window);
  const end = Math.min(lines.length, currentIndex + window + 1);

  const snippetLines = [];
  for (let i = start; i < end; i++) {
    const lineText = (lines[i].line || '').trim();
    if (!lineText) continue;

    if (i === currentIndex) {
      snippetLines.push(`**→ ${lineText} ←**`);
    } else {
      snippetLines.push(lineText);
    }
  }

  const joined = snippetLines.join('\n').trim();
  return joined || null;
}

module.exports = {
  fetchLyrics,
  findLineIndex,
  renderTimedSnippet,
  cleanLyricsText,
  getApproxPositionMs
};
