const jwt = require('jsonwebtoken');
const sessionStore = require('../../utils/sessionStore');

const JWT_SECRET = process.env.API_JWT_SECRET || 'change-me-in-production';

/**
 * Verify JWT token from Authorization header.
 * Sets req.user = { id, username, avatar, guilds }
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  try {
    const token = header.slice(7);
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Ensure the authenticated user is in the target guild's voice channel.
 * Requires :guildId param and req.user to be set.
 */
async function requireVoice(req, res, next) {
  const { guildId } = req.params;
  const client = req.botClient;
  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    return res.status(404).json({ error: 'Guild not found' });
  }

  let member = guild.members.cache.get(req.user.id);
  if (!member) {
    try {
      member = await guild.members.fetch(req.user.id);
    } catch {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }
  }

  // Try cached voice state directly (more reliable than member.voice after REST fetch)
  let voiceChannel = member.voice?.channel
    || guild.voiceStates.cache.get(req.user.id)?.channel;

  // Fallback: accept voiceChannelId from body/query for dashboard use
  if (!voiceChannel && (req.body?.voiceChannelId || req.query?.voiceChannelId)) {
    const vcId = req.body?.voiceChannelId || req.query?.voiceChannelId;
    voiceChannel = guild.channels.cache.get(vcId);
    if (!voiceChannel || voiceChannel.type !== 2) {
      return res.status(400).json({ error: 'Invalid voice channel ID' });
    }
  }

  if (!voiceChannel) {
    return res.status(400).json({ error: 'You must be in a voice channel or provide voiceChannelId' });
  }

  // Security: if the bot is already playing in a different channel, block the action.
  const existingPlayer = client.kazagumo?.players?.get(guildId);
  if (existingPlayer?.voiceId && existingPlayer.voiceId !== voiceChannel.id) {
    return res.status(403).json({
      error: 'The bot is playing in a different voice channel. Join that channel to control playback.',
      botVoiceChannelId: existingPlayer.voiceId
    });
  }

  req.guild = guild;
  req.member = member;
  req.voiceChannel = voiceChannel;

  // Register the user in the session store so their permissions are tracked
  const avatarUrl = member.displayAvatarURL({ size: 64, forceStatic: true });
  sessionStore.registerUser(guildId, req.user.id, req.user.username, avatarUrl);

  next();
}

/**
 * Middleware factory: enforce a specific web-dashboard permission.
 * Must be used AFTER requireAuth and requireVoice (which registers the user).
 * @param {'addTracks'|'removeTracks'|'controlPlayer'|'reorderQueue'} perm
 */
function requirePermission(perm) {
  return function checkPermission(req, res, next) {
    const { guildId } = req.params;
    if (!guildId) return next();
    if (!sessionStore.hasPermission(guildId, req.user.id, perm)) {
      return res.status(403).json({
        error: 'You do not have permission to perform this action',
        requires: perm
      });
    }
    next();
  };
}

/**
 * Sign a JWT for a Discord user.
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { requireAuth, requireVoice, requirePermission, signToken, JWT_SECRET };
