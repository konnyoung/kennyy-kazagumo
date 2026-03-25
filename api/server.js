const express = require('express');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./routes/auth');
const playerRoutes = require('./routes/player');
const queueRoutes = require('./routes/queue');
const searchRoutes = require('./routes/search');
const guildRoutes = require('./routes/guilds');
const lyricsRoutes = require('./routes/lyrics');
const playlistRoutes = require('./routes/playlists');
const permissionsRoutes = require('./routes/permissions');
const assetsRoutes = require('./routes/assets');
const feedbackRoutes = require('./routes/feedback');

function createApiServer(client) {
  const app = express();

  app.use(cors({
    origin: process.env.API_CORS_ORIGIN || '*',
    credentials: true
  }));
  app.use(express.json());

  // Permite que o Discord embuta o site como Activity (iframe)
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://discord.com https://*.discordsays.com"
    );
    next();
  });

  // Serve dashboard static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Inject bot client into all requests
  app.use((req, res, next) => {
    req.botClient = client;
    next();
  });

  // Health check
  app.get('/api', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/guilds', guildRoutes);
  app.use('/api/player', playerRoutes);
  app.use('/api/queue', queueRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/lyrics', lyricsRoutes);
  app.use('/api/playlists', playlistRoutes);
  app.use('/api/permissions', permissionsRoutes);
  app.use('/api/assets', assetsRoutes);
  app.use('/api/feedback', feedbackRoutes);

  // Error handler
  app.use((err, req, res, _next) => {
    console.error('[API Error]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  const port = parseInt(process.env.API_PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`🌐 API rodando na porta ${port}`);
  });

  return server;
}

module.exports = { createApiServer };
