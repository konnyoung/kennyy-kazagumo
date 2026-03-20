const { Router } = require('express');
const { signToken } = require('../middleware/auth');
const { logSiteLogin } = require('../../utils/webhookLogger');

const router = Router();

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * POST /api/auth/callback
 * Body: { code: string }
 * Exchanges a Discord OAuth2 code for user info and returns a JWT.
 */
router.post('/callback', async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const clientId = process.env.API_DISCORD_CLIENT_ID || process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.API_DISCORD_CLIENT_SECRET;
    const redirectUri = process.env.API_DISCORD_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).json({ error: 'OAuth2 not configured on server' });
    }

    // Exchange code for tokens
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(401).json({ error: 'Failed to exchange code', details: err });
    }

    const tokenData = await tokenRes.json();

    // Fetch user info
    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Failed to fetch user' });
    const user = await userRes.json();

    // Fetch user guilds
    const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const guilds = guildsRes.ok ? await guildsRes.json() : [];

    const jwt = signToken({
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      guildIds: guilds.map(g => g.id)
    });

    logSiteLogin({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      globalName: user.global_name
    }).catch(() => {});

    res.json({
      token: jwt,
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        globalName: user.global_name
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/activity
 * Body: { code: string }
 * Exchanges a Discord Embedded Activity SDK code for a JWT.
 * Uses a separate redirect URI configured for the Activity.
 */
router.post('/activity', async (req, res, next) => {
  try {
    const { code, redirectUri: bodyRedirectUri } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const clientId = process.env.API_DISCORD_CLIENT_ID;
    const clientSecret = process.env.API_DISCORD_CLIENT_SECRET;
    const redirectUri =
      bodyRedirectUri ||
      process.env.API_DISCORD_ACTIVITY_REDIRECT_URI ||
      process.env.API_DISCORD_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).json({
        error: 'Activity OAuth not configured on server (missing redirect URI)',
      });
    }

    // Exchange code for Discord access token
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(401).json({ error: 'Failed to exchange activity code', details: err });
    }

    const tokenData = await tokenRes.json();

    // Fetch user info
    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Failed to fetch user' });
    const discordUser = await userRes.json();

    // Fetch guilds
    const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const guilds = guildsRes.ok ? await guildsRes.json() : [];

    const jwtToken = signToken({
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator,
      avatar: discordUser.avatar,
      guildIds: guilds.map(g => g.id),
    });

    logSiteLogin({
      id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      globalName: discordUser.global_name,
    }).catch(() => {});

    res.json({
      token: jwtToken,
      user: {
        id: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
        globalName: discordUser.global_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Returns current user info from JWT (no Discord API call).
 */
const { requireAuth } = require('../middleware/auth');
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
