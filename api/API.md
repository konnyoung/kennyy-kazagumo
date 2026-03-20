# API Documentation

REST API for controlling the music bot via web dashboard.

## Setup

Add the following variables to your `.env`:

```env
API_ENABLED=true
API_PORT=3000
API_CORS_ORIGIN=http://localhost:5173
API_JWT_SECRET=your-secret-key-here
API_DISCORD_CLIENT_ID=your-discord-app-client-id
API_DISCORD_CLIENT_SECRET=your-discord-app-client-secret
API_DISCORD_REDIRECT_URI=http://localhost:5173/callback
```

The Discord application must have the OAuth2 redirect URI configured to match `API_DISCORD_REDIRECT_URI`.

**Required OAuth2 scopes:** `identify`, `guilds`

---

## Authentication

All endpoints (except `/api/auth/callback` and `/api/health`) require a JWT token in the `Authorization` header:

```
Authorization: Bearer <token>
```

### OAuth2 Flow

1. Redirect the user to Discord's OAuth2 authorize URL:
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=identify+guilds
   ```

2. After the user authorizes, Discord redirects to your `redirect_uri` with a `code` parameter.

3. Exchange the code for a JWT via the API:
   ```
   POST /api/auth/callback
   ```

---

## Endpoints

### Health

#### `GET /api/health`

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "uptime": 12345.678
}
```

---

### Auth

#### `POST /api/auth/callback`

Exchange a Discord OAuth2 authorization code for a JWT token.

**Body:**
```json
{
  "code": "discord-oauth2-code"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "123456789",
    "username": "User",
    "avatar": "abc123",
    "globalName": "Display Name"
  }
}
```

#### `GET /api/auth/me`

Returns current user info from JWT.

**Response:**
```json
{
  "user": {
    "id": "123456789",
    "username": "User",
    "avatar": "abc123",
    "guildIds": ["111", "222"]
  }
}
```

---

### Guilds

#### `GET /api/guilds`

Returns guilds the bot shares with the authenticated user.

**Response:**
```json
{
  "guilds": [
    {
      "id": "111222333",
      "name": "My Server",
      "icon": "https://cdn.discordapp.com/icons/...",
      "memberCount": 42,
      "hasPlayer": true
    }
  ]
}
```

#### `GET /api/guilds/:guildId`

Returns detailed guild info including voice channels and player state.

**Response:**
```json
{
  "id": "111222333",
  "name": "My Server",
  "icon": "https://cdn.discordapp.com/icons/...",
  "voiceChannels": [
    {
      "id": "444555666",
      "name": "General",
      "members": [
        { "id": "789", "username": "User", "avatar": "https://..." }
      ]
    }
  ],
  "player": {
    "voiceId": "444555666",
    "textId": "777888999",
    "playing": true,
    "paused": false,
    "loop": "none",
    "volume": 100
  }
}
```

---

### Player

#### `GET /api/player/:guildId`

Returns current player state.

**Response (active):**
```json
{
  "active": true,
  "playing": true,
  "paused": false,
  "volume": 100,
  "position": 45000,
  "loop": "none",
  "voiceId": "444555666",
  "current": {
    "title": "Song Name",
    "author": "Artist",
    "uri": "https://...",
    "identifier": "dQw4w9WgXcQ",
    "length": 213000,
    "thumbnail": "https://...",
    "requester": {
      "id": "789",
      "username": "User",
      "avatar": "https://..."
    }
  },
  "queueLength": 5
}
```

**Response (inactive):**
```json
{
  "active": false
}
```

#### `POST /api/player/:guildId/play`

Search and play a track. Requires the user to be in a voice channel.

**Body:**
```json
{
  "query": "never gonna give you up"
}
```

The `query` can be a search term (searches Spotify by default) or a direct URL (YouTube, Spotify, SoundCloud, etc.).

**Response:**
```json
{
  "added": [
    {
      "title": "Never Gonna Give You Up",
      "author": "Rick Astley",
      "uri": "https://...",
      "length": 213000,
      "thumbnail": "https://..."
    }
  ],
  "playlistName": null,
  "queueLength": 1,
  "playing": true
}
```

#### `POST /api/player/:guildId/pause`

Pause playback. Requires voice channel.

**Response:**
```json
{ "paused": true }
```

#### `POST /api/player/:guildId/resume`

Resume playback. Requires voice channel.

**Response:**
```json
{ "paused": false }
```

#### `POST /api/player/:guildId/skip`

Skip the current track. Requires voice channel.

**Response:**
```json
{ "skipped": true }
```

#### `POST /api/player/:guildId/stop`

Stop playback, clear queue, and disconnect. Requires voice channel.

**Response:**
```json
{ "stopped": true }
```

#### `POST /api/player/:guildId/seek`

Seek to a position in the current track. Requires voice channel.

**Body:**
```json
{
  "position": 60000
}
```

Position is in **milliseconds**.

**Response:**
```json
{ "position": 60000 }
```

#### `POST /api/player/:guildId/volume`

Set player volume (0–150). Requires voice channel.

**Body:**
```json
{
  "volume": 80
}
```

**Response:**
```json
{ "volume": 80 }
```

#### `POST /api/player/:guildId/loop`

Set loop mode. Requires voice channel.

**Body:**
```json
{
  "mode": "queue"
}
```

Valid modes: `none`, `track`, `queue`

**Response:**
```json
{ "loop": "queue" }
```

---

### Queue

#### `GET /api/queue/:guildId`

Returns the full queue.

**Response:**
```json
{
  "current": {
    "index": -1,
    "title": "Current Song",
    "author": "Artist",
    "uri": "https://...",
    "length": 213000,
    "thumbnail": "https://..."
  },
  "tracks": [
    {
      "index": 0,
      "title": "Next Song",
      "author": "Artist",
      "uri": "https://...",
      "length": 180000,
      "thumbnail": "https://..."
    }
  ],
  "length": 1,
  "loop": "none",
  "position": 45000
}
```

#### `DELETE /api/queue/:guildId`

Clear the entire queue (keeps current track playing). Requires voice channel.

**Response:**
```json
{ "cleared": true, "length": 0 }
```

#### `DELETE /api/queue/:guildId/:index`

Remove a specific track from the queue by index. Requires voice channel.

**Response:**
```json
{
  "removed": {
    "index": 2,
    "title": "Removed Song",
    "author": "Artist"
  },
  "length": 4
}
```

#### `POST /api/queue/:guildId/shuffle`

Shuffle the queue. Requires voice channel.

**Response:**
```json
{
  "shuffled": true,
  "tracks": [...],
  "length": 5
}
```

#### `POST /api/queue/:guildId/skipto`

Skip to a specific track in the queue by index. Requires voice channel.

**Body:**
```json
{
  "index": 3
}
```

**Response:**
```json
{ "skippedTo": 3 }
```

---

### Search

#### `GET /api/search?q=query&source=spotify`

Search for tracks without playing them.

**Query params:**
| Param | Required | Default | Options |
|-------|----------|---------|---------|
| `q` | Yes | — | Search query or URL |
| `source` | No | `spotify` | `spotify`, `youtube`, `soundcloud` |

**Response:**
```json
{
  "tracks": [
    {
      "title": "Song Name",
      "author": "Artist",
      "uri": "https://...",
      "identifier": "abc123",
      "length": 213000,
      "thumbnail": "https://..."
    }
  ],
  "type": "SEARCH",
  "playlistName": null
}
```

Returns up to 25 results.

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (missing params, invalid values) |
| 401 | Not authenticated / invalid token |
| 403 | Not a member of the guild |
| 404 | Guild/player not found or no search results |
| 500 | Internal server error |

---

## File Structure

```
api/
├── server.js              # Express app setup and startup
├── middleware/
│   └── auth.js            # JWT verification, voice channel check
└── routes/
    ├── auth.js            # Discord OAuth2 login
    ├── guilds.js          # Guild listing and details
    ├── player.js          # Playback controls
    ├── queue.js           # Queue management
    └── search.js          # Track search
```
