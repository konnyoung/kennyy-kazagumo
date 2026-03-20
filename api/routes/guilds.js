const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

const router = Router();

/**
 * GET /api/guilds
 * Returns guilds the bot shares with the authenticated user.
 */
router.get('/', requireAuth, (req, res) => {
  const client = req.botClient;
  const userGuildIds = new Set(req.user.guildIds || []);

  const mutual = [];
  for (const [id, guild] of client.guilds.cache) {
    if (userGuildIds.has(id)) {
      // Check if user is in a voice channel in this guild
      const userVoiceState = guild.voiceStates.cache.get(req.user.id);
      mutual.push({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL({ size: 128 }),
        memberCount: guild.memberCount,
        hasPlayer: client.kazagumo.players.has(id),
        userVoiceChannelId: userVoiceState?.channelId || null
      });
    }
  }

  res.json({ guilds: mutual });
});

/**
 * GET /api/guilds/:guildId
 * Returns info about a specific guild + voice channels.
 */
router.get('/:guildId', requireAuth, async (req, res) => {
  const client = req.botClient;
  const guild = client.guilds.cache.get(req.params.guildId);

  if (!guild) return res.status(404).json({ error: 'Guild not found' });

  let member = guild.members.cache.get(req.user.id);
  if (!member) {
    try {
      member = await guild.members.fetch(req.user.id);
    } catch {
      return res.status(403).json({ error: 'Not a member of this guild' });
    }
  }

  const voiceChannels = guild.channels.cache
    .filter(c => c.type === 2) // GuildVoice
    .map(c => ({
      id: c.id,
      name: c.name,
      members: c.members.filter(m => !m.user.bot).map(m => ({
        id: m.id,
        username: m.user.username,
        avatar: m.user.displayAvatarURL({ size: 64 })
      }))
    }));

  const player = client.kazagumo.players.get(guild.id);

  res.json({
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ size: 256 }),
    voiceChannels,
    player: player ? {
      voiceId: player.voiceId,
      textId: player.textId,
      playing: player.playing,
      paused: player.paused,
      loop: player.loop,
      volume: player.volume
    } : null
  });
});

module.exports = router;
