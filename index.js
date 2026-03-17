require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Collection,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SeparatorBuilder,
  TextDisplayBuilder
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Kazagumo } = require('kazagumo');
const { Connectors, Constants } = require('shoukaku');
const Spotify = require('kazagumo-spotify');
const { createLavalinkMonitor } = require('./utils/lavalinkMonitor');
const { startTerminalPanel } = require('./utils/terminalPanel');
const { createI18n } = require('./utils/i18n');
const { createLogSettingsStore } = require('./utils/logSettingsStore');
const { createPresenceStore } = require('./utils/presenceStore');
const { getTranslator } = require('./utils/localeHelpers');
const { fetchLyrics, findLineIndex, renderTimedSnippet, getApproxPositionMs } = require('./utils/lyricsManager');
const { buildV2Container, v2Payload, v2Reply } = require('./utils/embedV2');
const { createQueueCacheStore } = require('./utils/queueCacheStore');

console.log('🚀 Iniciando Music Bot...');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.log('❌ DISCORD_TOKEN não encontrado nas variáveis de ambiente!');
  throw new Error('Missing DISCORD_TOKEN in environment variables.');
}

const TRACK_SOURCE_ICONS = Object.freeze({
  ytmusic: process.env.EMOJI_YTMUSIC || '<:ytmusic:1446620983267037395>',
  youtube: process.env.EMOJI_YOUTUBE || '<:youtube:1483286021297672315>',
  deezer: process.env.EMOJI_DEEZER || '<:deezer:1483286023604670674>',
  spotify: process.env.EMOJI_SPOTIFY || '<:spotify:1446621523631931423>',
  applemusic: process.env.EMOJI_APPLEMUSIC || '<:applemusic:1483286022401036408>',
  soundcloud: process.env.EMOJI_SOUNDCLOUD || '<:soundcloud:1483286020005826660>',
  twitch: process.env.EMOJI_TWITCH || '<:twitch:1483286084514484286>'
});

const TRACK_SOURCE_COLORS = Object.freeze({
  ytmusic: 0xff0050,
  youtube: 0xff0000,
  deezer: 0xff9900,
  spotify: 0x1db954,
  applemusic: 0xfa2d48,
  soundcloud: 0xff5500,
  twitch: 0x9146ff
});

const BASSBOOST_LEVELS = Object.freeze({
  high: [
    { band: 0, gain: 0.6 },
    { band: 1, gain: 0.67 },
    { band: 2, gain: 0.67 },
    { band: 3, gain: 0.4 },
    { band: 4, gain: -0.5 },
    { band: 5, gain: -0.5 },
    { band: 6, gain: -0.45 },
    { band: 7, gain: -0.5 },
    { band: 8, gain: -0.5 },
    { band: 9, gain: -0.5 },
    { band: 10, gain: -0.5 }
  ],
  medium: [
    { band: 0, gain: 0.35 },
    { band: 1, gain: 0.23 },
    { band: 2, gain: 0.26 },
    { band: 3, gain: 0.25 },
    { band: 4, gain: -0.1 },
    { band: 5, gain: -0.15 },
    { band: 6, gain: -0.15 },
    { band: 7, gain: -0.15 },
    { band: 8, gain: -0.15 },
    { band: 9, gain: -0.15 },
    { band: 10, gain: -0.15 }
  ],
  low: [
    { band: 0, gain: 0.2 },
    { band: 1, gain: 0.15 },
    { band: 2, gain: 0.15 },
    { band: 3, gain: 0.15 },
    { band: 4, gain: 0.1 },
    { band: 5, gain: 0.05 },
    { band: 6, gain: 0 },
    { band: 7, gain: 0 },
    { band: 8, gain: -0.15 },
    { band: 9, gain: -0.15 },
    { band: 10, gain: -0.15 }
  ]
});

let antiCrashReady = false;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

log('✅ Cliente Discord criado');
log('🌍 Inicializando sistema de i18n...');
const i18n = createI18n({
  localesDir: path.join(__dirname, 'locales'),
  defaultLocale: 'en',
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB_NAME,
  log
});

client.i18n = i18n;
log('✅ Sistema de i18n inicializado');

log('💾 Inicializando stores do MongoDB...');
const presenceStore = createPresenceStore({
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB_NAME,
  log
});

client.presenceStore = presenceStore;

const logSettingsStore = createLogSettingsStore({
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB_NAME,
  log
});

client.logSettingsStore = logSettingsStore;
log('✅ Stores do MongoDB inicializados');

log('📦 Inicializando cache de filas...');
const queueCache = createQueueCacheStore({ log });
client.queueCache = queueCache;
log('✅ Cache de filas inicializado');

setupAntiCrash();

log('📂 Carregando comandos...');
client.commands = new Collection();
const slashDefinitions = [];
loadCommands(path.join(__dirname, 'commands'));
log(`✅ ${client.commands.size} comandos carregados`);

client.queueState = new Map();

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const lavalinkNodes = loadLavalinkNodes();
log(`📡 Configurados ${lavalinkNodes.length} nó(s) Lavalink`);

client.kazagumo = new Kazagumo(
  {
    defaultSearchEngine: 'youtube',
    plugins: [
      new Spotify({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        playlistPageLimit: 1,
        albumPageLimit: 1,
        searchLimit: 10
      })
    ],
    send(guildId, payload) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        guild.shard.send(payload);
      }
    }
  },
  new Connectors.DiscordJS(client),
  lavalinkNodes,
  // Shoukaku options for connection stability
  {
    resume: true,
    resumeTimeout: 30,
    resumeByLibrary: true,
    reconnectTries: 5,
    reconnectInterval: 5000,
    restTimeout: 60000,
    moveOnDisconnect: true,
    userAgent: 'KennyBot/1.0',
    structures: {
      rest: undefined,
      player: undefined
    },
    voiceConnectionTimeout: 30000
  }
);

log('✅ Kazagumo inicializado com sucesso');

const lavalinkMonitor = createLavalinkMonitor({
  client,
  nodeConfigs: lavalinkNodes,
  log
});
lavalinkMonitor.start();
client.lavalinkMonitor = lavalinkMonitor;
log('✅ Monitor Lavalink iniciado');

let panelController = null;

client.softRestart = async () => {
  if (client._softRestarting) return;
  client._softRestarting = true;

  log('🔄 Soft restart solicitado...');

  // Ensure no players linger.
  try {
    const players = Array.from(client.kazagumo?.players?.values?.() ?? []);
    log(`🧹 Limpando ${players.length} player(s) ativo(s)...`);
    for (const player of players) {
      try {
        await player.destroy();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    log(`❌ Falha ao destruir players: ${error?.message ?? error}`);
  }

  // Reconnect the Discord gateway without killing the process.
  try {
    log('🔌 Desconectando do Discord...');
    await client.destroy();
  } catch (error) {
    log(`❌ Falha ao destruir cliente Discord: ${error?.message ?? error}`);
  }

  try {
    log('🔌 Reconectando ao Discord...');
    await client.login(DISCORD_TOKEN);
    log('✅ Soft restart concluído com sucesso');
  } catch (error) {
    log(`❌ Falha ao reconectar após soft restart: ${error?.message ?? error}`);
  } finally {
    client._softRestarting = false;
  }
};

client.kazagumo.shoukaku.on('ready', async name => {
  log(`🟢 Lavalink: Nó '${name}' está pronto!`);

  // Quando um node reconecta, destruir todos os players desse node
  // para evitar "Session not found" - força rebuild com nova sessão
  const affectedPlayers = Array.from(client.kazagumo.players.values()).filter(player => {
    const playerNodeName = player?.shoukaku?.node?.name;
    return playerNodeName === name;
  });

  if (affectedPlayers.length > 0) {
    log(`[Reconnect] Limpando ${affectedPlayers.length} player(s) do nó reconectado '${name}'...`);
    for (const player of affectedPlayers) {
      try {
        await player.destroy();
        log(`[Reconnect] Player ${player.guildId} destruído com sucesso.`);
      } catch (error) {
        // Força remoção se destroy falhar
        client.kazagumo.players.delete(player.guildId);
        log(`[Reconnect] Player ${player.guildId} removido forcadamente.`);
      }
    }
  }
});

client.kazagumo.shoukaku.on('error', (name, error) => {
  log(`❌ Lavalink: Erro no nó '${name}': ${error?.message ?? error}`);
  
  // Send user-friendly error message for RestError
  if (error?.message?.includes('Unexpected error response from Lavalink')) {
    sendLavalinkErrorMessage(name);
  }
});

async function sendLavalinkErrorMessage(nodeName) {
  // Send error message to all active players on this node
  for (const [guildId, player] of client.kazagumo.players) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      
      const textChannelId = player.textId;
      if (!textChannelId) continue;
      
      const textChannel = guild.channels.cache.get(textChannelId);
      if (!textChannel?.isTextBased?.()) continue;
      
      const t = await getTranslator(client, guildId);
      const title = t('errors.lavalink_error_title');
      const description = t('errors.lavalink_error_description');
      
      await textChannel.send(v2Reply({
        color: 0xff6b6b,
        title: `${process.env.EMOJI_SCARED || '<a:scared:1451994355358499040>'} ${title}`,
        description,
        footer: `Node: ${nodeName}`,
        timestamp: true
      }));
      
      // Only send once per guild
      break;
    } catch (error) {
      // Ignore errors when sending error message
    }
  }
}

client.kazagumo.on('playerStart', async (player, track) => {
  const channel = client.channels.cache.get(player.textId);
  if (!channel) return;
  const t = await getTranslator(client, player.guildId);

  // Save queue to cache whenever a track starts (for /resumequeue)
  try {
    client.queueCache.saveQueue(player.guildId, track, player.queue);
  } catch (error) {
    log(`[QueueCache] Failed to save queue: ${error.message}`);
  }

  cleanupProgressUpdater(player);
  await deleteNowPlayingEmbed(player);
  const { payload, cardBuffer } = await buildNowPlayingMessage(player, track, t);
  try {
    const message = await channel.send(payload);
    player.data.set('nowPlayingMessage', message);
    startProgressUpdater(player);

    // Delete the searching/stage interaction reply now that Now Playing is visible
    const searchingInteraction = player.data.get('searchingInteraction');
    if (searchingInteraction) {
      player.data.delete('searchingInteraction');
      searchingInteraction.deleteReply().catch(() => {});
    }
  } catch (error) {
    log(`Failed to send now playing embed: ${error.message}`);
  }

  await sendMusicStartLog(player, track, cardBuffer);
});

client.kazagumo.on('playerEnd', async player => {
  cleanupProgressUpdater(player);
  await deleteNowPlayingEmbed(player);
  await stopLyrics(player, { deleteMessage: true });
});

client.kazagumo.on('playerEmpty', async player => {
  cleanupProgressUpdater(player);
  await deleteNowPlayingEmbed(player);
  
  // Envia embed do Top.gg e desconecta
  try {
    const t = await getTranslator(client, player.guildId);
    const channel = client.channels.cache.get(player.textId);
    
    if (channel) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(t('logs.player.queue_finished.website')).setURL('https://kennyy.com.br').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel(t('logs.player.queue_finished.support')).setURL('https://discord.gg/3sTbFm8WRt').setStyle(ButtonStyle.Link)
      );
      
      await channel.send(v2Reply({ title: t('logs.player.queue_finished.title'), components: [row] }));
    }
  } catch (error) {
    console.error('Erro ao enviar embed de fila finalizada:', error);
  }
  
  // Desconecta do canal de voz
  try {
    if (client.kazagumo.players.get(player.guildId)) {
      await player.destroy();
    }
  } catch {}
});

client.kazagumo.on('playerDestroy', async player => {
  cleanupProgressUpdater(player);
  await deleteNowPlayingEmbed(player);
});

client.once(Events.ClientReady, async readyClient => {
  log(`🟢 ${readyClient.user.tag} está online!`);
  log(`🆔 ID do Bot: ${readyClient.user.id}`);

  try {
    await rest.put(Routes.applicationCommands(readyClient.user.id), {
      body: slashDefinitions
    });
    log(`✅ Sincronizados ${slashDefinitions.length} comandos slash`);
  } catch (error) {
    log(`❌ Falha ao sincronizar comandos: ${error.message}`);
  }

  if (!panelController) {
    panelController = startTerminalPanel({ monitor: lavalinkMonitor, log });
    log('📊 Painel de monitoramento iniciado');
    log('💡 Pressione "l" para alternar entre painel e logs');
  }
  if (client.presenceStore) {
    try {
      await applyStoredPresence();
    } catch (error) {
      log(`❌ Falha ao aplicar presença: ${error.message}`);
    }
  }

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('✅ Bot inicializado com sucesso!');
  log(`📊 Servidores: ${readyClient.guilds.cache.size}`);
  log(`👥 Usuários: ${readyClient.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0)}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

client.on(Events.GuildCreate, async guild => {
  log(`📥 Bot joined guild: ${guild.name} (ID: ${guild.id})`);
  
  const logChannelId = process.env.LOG_CHANNEL_ID;
  if (!logChannelId || !client.logSettingsStore) {
    return;
  }

  let enabled = false;
  try {
    enabled = await client.logSettingsStore.isMusicLogsEnabled();
  } catch (error) {
    log(`[Logs] Failed to check log status: ${error.message}`);
    return;
  }

  if (!enabled) {
    return;
  }

  try {
    const logChannel = await client.channels.fetch(logChannelId);
    if (!logChannel?.isTextBased()) {
      return;
    }

    const t = await getTranslator(client, guild.id);
    const unknown = t('logs.common.unknown', { default: 'Desconhecido' });
    const fields = [
      { name: t('logs.guild_join.fields.name', { default: 'Nome do Servidor' }), value: guild.name },
      { name: t('logs.guild_join.fields.id', { default: 'ID do Servidor' }), value: `\`${guild.id}\`` }
    ];

    if (guild.memberCount) {
      fields.push({ name: t('logs.guild_join.fields.members', { default: 'Membros' }), value: t('logs.common.member_count', { default: '{count} membros', count: guild.memberCount.toLocaleString() }) });
    }
    if (guild.ownerId) {
      fields.push({ name: t('logs.guild_join.fields.owner', { default: 'Dono' }), value: `<@${guild.ownerId}> (\`${guild.ownerId}\`)` });
    }
    if (guild.createdAt) {
      fields.push({ name: t('logs.guild_join.fields.created_at', { default: 'Criado em' }), value: guild.createdAt.toLocaleDateString('pt-BR') });
    }

    const verificationLevels = {
      0: 'logs.common.verification.none',
      1: 'logs.common.verification.low',
      2: 'logs.common.verification.medium',
      3: 'logs.common.verification.high',
      4: 'logs.common.verification.highest'
    };
    const verificationKey = verificationLevels[guild.verificationLevel] || 'logs.common.unknown';
    fields.push({ name: t('logs.guild_join.fields.verification', { default: 'Verificação' }), value: t(verificationKey, { default: unknown }) });

    const boostCount = guild.premiumSubscriptionCount || 0;
    const boostKey = boostCount ? 'logs.common.boost.with_count' : 'logs.common.boost.basic';
    fields.push({
      name: t('logs.guild_join.fields.boost', { default: 'Boost' }),
      value: t(boostKey, { default: boostCount ? `Nível ${guild.premiumTier} (${boostCount} boosts)` : `Nível ${guild.premiumTier}`, tier: guild.premiumTier, count: boostCount })
    });

    fields.push({
      name: t('logs.guild_join.fields.total', { default: 'Total de Servidores' }),
      value: t('logs.guild_join.summary', { default: '🌐 Agora estou em **{total}** servidores!', total: client.guilds.cache.size })
    });

    await logChannel.send(v2Reply({
      color: 0xF53F5F,
      title: t('logs.guild_join.title', { default: '📥 Entrei em um novo servidor!' }),
      fields,
      timestamp: true
    }));
  } catch (error) {
    log(`Failed to send guild join log: ${error.message}`);
  }
});

client.on(Events.GuildDelete, async guild => {
  log(`📤 Bot left guild: ${guild.name} (ID: ${guild.id})`);
  
  const logChannelId = process.env.LOG_CHANNEL_ID;
  if (!logChannelId || !client.logSettingsStore) {
    return;
  }

  let enabled = false;
  try {
    enabled = await client.logSettingsStore.isMusicLogsEnabled();
  } catch (error) {
    log(`[Logs] Failed to check log status: ${error.message}`);
    return;
  }

  if (!enabled) {
    return;
  }

  try {
    const logChannel = await client.channels.fetch(logChannelId);
    if (!logChannel?.isTextBased()) {
      return;
    }

    const t = await getTranslator(client, guild.id);
    const unknown = t('logs.common.unknown', { default: 'Desconhecido' });
    const fields = [
      { name: t('logs.guild_remove.fields.name', { default: 'Nome do Servidor' }), value: guild.name },
      { name: t('logs.guild_remove.fields.id', { default: 'ID do Servidor' }), value: `\`${guild.id}\`` }
    ];

    if (guild.memberCount) {
      fields.push({ name: t('logs.guild_remove.fields.members', { default: 'Membros' }), value: t('logs.common.member_count', { default: '{count} membros', count: guild.memberCount.toLocaleString() }) });
    }
    if (guild.ownerId) {
      fields.push({ name: t('logs.guild_remove.fields.owner', { default: 'Dono' }), value: `<@${guild.ownerId}> (\`${guild.ownerId}\`)` });
    }
    if (guild.createdAt) {
      fields.push({ name: t('logs.guild_remove.fields.created_at', { default: 'Criado em' }), value: guild.createdAt.toLocaleDateString('pt-BR') });
    }

    const verificationLevels = {
      0: 'logs.common.verification.none',
      1: 'logs.common.verification.low',
      2: 'logs.common.verification.medium',
      3: 'logs.common.verification.high',
      4: 'logs.common.verification.highest'
    };
    const verificationKey = verificationLevels[guild.verificationLevel] || 'logs.common.unknown';
    fields.push({ name: t('logs.guild_remove.fields.verification', { default: 'Verificação' }), value: t(verificationKey, { default: unknown }) });

    const boostCount = guild.premiumSubscriptionCount || 0;
    const boostKey = boostCount ? 'logs.common.boost.with_count' : 'logs.common.boost.basic';
    fields.push({
      name: t('logs.guild_remove.fields.boost', { default: 'Boost' }),
      value: t(boostKey, { default: boostCount ? `Nível ${guild.premiumTier} (${boostCount} boosts)` : `Nível ${guild.premiumTier}`, tier: guild.premiumTier, count: boostCount })
    });

    fields.push({
      name: t('logs.guild_remove.fields.total', { default: 'Total de Servidores' }),
      value: t('logs.guild_remove.summary', { default: '🌐 Agora estou em **{total}** servidores', total: client.guilds.cache.size })
    });

    await logChannel.send(v2Reply({
      color: 0xF53F5F,
      title: t('logs.guild_remove.title', { default: '📤 Saí de um servidor' }),
      fields,
      timestamp: true
    }));
  } catch (error) {
    log(`Failed to send guild leave log: ${error.message}`);
  }
});

// Voice State Update - Monitor when users join/leave voice channels
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  if (!guild) return;

  // Only evaluate if someone other than the bot changed state
  if (newState.member?.id !== client.user?.id) {
    await evaluateVoiceChannel(guild);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) {
      const t = await getTranslator(client, interaction.guildId);
      return interaction.reply({ content: t('errors.unknown_command'), ephemeral: true });
    }

    // Check global command lock (only bot owners bypass)
    if (client._commandLock?.enabled && interaction.commandName !== 'admin') {
      const ownerIds = (process.env.BOT_OWNER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
      const isOwner = ownerIds.includes(String(interaction.user.id));
      if (!isOwner) {
        const lock = client._commandLock;
        const lockPayload = v2Reply({ color: 0xed4245, title: lock.title || '🔒', description: lock.description || '...', timestamp: true, components: lock.buttons?.length ? [new ActionRowBuilder().addComponents(...lock.buttons)] : undefined });
        return interaction.reply({ ...lockPayload, ephemeral: true });
      }
    }

    try {
      await command.execute(interaction, client);
    } catch (error) {
      const t = await getTranslator(client, interaction.guildId);
      log(`Command error ${interaction.commandName}: ${error.message}`);

      // Only attempt Lavalink reconnects for music-related commands (async, don't wait)
      if (isLavalinkCommand(interaction.commandName)) {
        attemptReconnectLavalink(client).catch(err => 
          log(`[Lavalink] Reconnect attempt failed: ${err.message}`)
        );
      }

      // Try to respond to the user, but handle expired interactions gracefully
      const response = { content: t('errors.command_failed'), ephemeral: true };
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(response);
        } else {
          await interaction.reply(response);
        }
      } catch (replyError) {
        // Interaction likely expired (Unknown interaction or already acknowledged)
        log(`Failed to send error response: ${replyError.message}`);
      }
    }
  } else if (interaction.isButton()) {
    try {
      const t = await getTranslator(client, interaction.guildId);
      await handlePlaybackButton(interaction, t);
    } catch (error) {
      log(`Unhandled button interaction error: ${error.message}`);
    }
  } else if (interaction.isModalSubmit() && interaction.customId === 'admin_lock_modal') {
    try {
      log('[Lock] Modal submitted');
      const t = await getTranslator(client, interaction.guildId);
      const lockTitle = interaction.fields.getTextInputValue('lock_title');
      const lockDescription = interaction.fields.getTextInputValue('lock_description');
      const link1 = interaction.fields.getTextInputValue('lock_link1')?.trim() || '';
      const link2 = interaction.fields.getTextInputValue('lock_link2')?.trim() || '';
      const link3 = interaction.fields.getTextInputValue('lock_link3')?.trim() || '';

      const buttons = [];
      for (const raw of [link1, link2, link3]) {
        if (!raw) continue;
        const sepIndex = raw.indexOf('|');
        if (sepIndex === -1) continue;
        const label = raw.slice(0, sepIndex).trim();
        const url = raw.slice(sepIndex + 1).trim();
        if (!label || !url || !/^https?:\/\//.test(url)) continue;
        buttons.push(new ButtonBuilder().setLabel(label).setURL(url).setStyle(ButtonStyle.Link));
      }

      client._commandLock = { enabled: true, title: lockTitle, description: lockDescription, buttons };
      log(`[Lock] Enabled. Title: ${lockTitle}, Buttons: ${buttons.length}`);

      await interaction.reply({ ...v2Reply({ color: 0xF53F5F, title: t('commands.admin.lock.enabled_title'), description: t('commands.admin.lock.enabled_description'), timestamp: true }), ephemeral: true });
    } catch (error) {
      log(`Lock modal error: ${error.message}`);
      try {
        await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
      } catch { /* ignore */ }
    }
  }
});

log('🔐 Conectando ao Discord...');
client.login(DISCORD_TOKEN);

process.once('SIGINT', async () => {
  log('🛑 SIGINT recebido. Encerrando bot...');
  panelController?.stop?.();
  lavalinkMonitor.stop();
  log('✅ Monitor Lavalink encerrado');
  try {
    await i18n.close();
    log('✅ Sistema de i18n fechado');
  } catch (error) {
    log(`❌ Falha ao fechar i18n: ${error.message}`);
  }

  if (presenceStore?.close) {
    try {
      await presenceStore.close();
      log('✅ Presence store fechado');
    } catch (error) {
      log(`❌ Falha ao fechar presence store: ${error.message}`);
    }
  }

  if (logSettingsStore?.close) {
    try {
      await logSettingsStore.close();
      log('✅ Logs store fechado');
    } catch (error) {
      log(`❌ Falha ao fechar logs store: ${error.message}`);
    }
  }
  log('👋 Bot encerrado com sucesso');
  process.exit(0);
});

function loadCommands(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loadCommands(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      const command = require(fullPath);
      if (!command?.data || !command?.execute) {
        log(`⚠️ Comando inválido ignorado: ${entry.name}`);
        continue;
      }
      client.commands.set(command.data.name, command);
      slashDefinitions.push(command.data.toJSON());
      log(`✅ Comando carregado: ${command.data.name}`);
    }
  }
}

function loadLavalinkNodes() {
  log('🔍 Carregando configurações dos nós Lavalink...');
  const nodes = [];
  for (let i = 1; i <= 10; i += 1) {
    const host = process.env[`LAVALINK_NODE${i}_HOST`];
    const port = process.env[`LAVALINK_NODE${i}_PORT`];
    const password = process.env[`LAVALINK_NODE${i}_PASSWORD`];
    if (!host || !port || !password) continue;
    const nodeName = process.env[`LAVALINK_NODE${i}_NAME`] ?? `Node-${i}`;
    nodes.push({
      name: nodeName,
      url: `${host}:${port}`,
      auth: password,
      secure: process.env[`LAVALINK_NODE${i}_SECURE`] === 'true',
      group: process.env[`LAVALINK_NODE${i}_GROUP`]
    });
    log(`  • Nó ${i}: ${nodeName} (${host}:${port})`);
  }
  if (!nodes.length) {
    log('❌ Nenhum nó Lavalink configurado!');
    throw new Error('No Lavalink nodes configured in the .env file.');
  }
  return nodes;
}

async function applyStoredPresence() {
  if (!client.presenceStore) {
    return;
  }
  const config = await client.presenceStore.getConfig();
  if (!config) {
    log('⚠️ Nenhuma presença configurada, usando padrão');
    return;
  }
  await client.presenceStore.applyConfig(client, config);
  log('✅ Presença aplicada com sucesso');
}

async function handlePlaybackButton(interaction, providedT) {
  const t = providedT ?? (await getTranslator(client, interaction.guildId));
  
  // Handle resumequeue button (doesn't require existing player)
  if (interaction.customId?.startsWith('resumequeue:')) {
    return handleResumeQueueButton(interaction, t);
  }
  
  const player = client.kazagumo.players.get(interaction.guildId);
  if (!player) {
    return interaction.reply({ content: t('common.no_player'), ephemeral: true });
  }

  if (interaction.customId === 'lyrics_stop') {
    await handleLyricsStop(interaction, player, t);
    return;
  }

  if (interaction.customId?.startsWith('filter_')) {
    return handleFilterButton(interaction, player, t);
  }

  if (interaction.customId?.startsWith('queue_')) {
    return handleQueueButton(interaction, player, t);
  }

  const voiceChannelId = interaction.member?.voice?.channelId;
  if (!voiceChannelId || voiceChannelId !== player.voiceId) {
    return interaction.reply({ content: t('common.not_same_channel'), ephemeral: true });
  }

  const handlers = {
    'music-volume-down': async () => {
      const newVolume = Math.max(player.volume - 10, 10);
      await player.setVolume(newVolume);
      await interaction.deferUpdate();
      await refreshNowPlayingMessage(player);
    },
    'music-volume-up': async () => {
      const newVolume = Math.min(player.volume + 10, 150);
      await player.setVolume(newVolume);
      await interaction.deferUpdate();
      await refreshNowPlayingMessage(player);
    },
    'music-playpause': async () => {
      await player.pause(!player.paused);
      await interaction.deferUpdate();
      await refreshNowPlayingMessage(player);
    },
    'music-stop': async () => {
      await interaction.deferUpdate();
      player.queue.clear();
      try { player.shoukaku.stopTrack(); } catch {}
      try { await player.destroy(); } catch {}
    },
    'music-skip': async () => {
      await player.skip();
      await interaction.deferUpdate();
    },
    'music-loop': async () => {
      cycleLoopMode(player);
      await interaction.deferUpdate();
      await refreshNowPlayingMessage(player);
    },
    'music-shuffle': async () => {
      if (!player.queue.length || player.queue.length < 2) {
        return interaction.reply({ content: t('commands.shuffle.empty'), ephemeral: true });
      }
      player.queue.shuffle();
      await interaction.reply({ content: `🔀 ${t('commands.shuffle.success')}`, ephemeral: false });
    },
    'music-queue': async () => {
      const queueDescription = buildQueueDescription(player, t);
      await interaction.reply({ ...v2Reply({ color: 0xF53F5F, title: t('queue.title'), description: queueDescription, timestamp: true }), ephemeral: true });
    },
    'music-lyrics': async () => {
      await handleLyricsButton(interaction, player, t);
    }
  };

  const handler = handlers[interaction.customId];
  if (!handler) {
    return interaction.reply({ content: t('errors.button_unknown'), ephemeral: true });
  }

  try {
    await handler();
  } catch (error) {
    log(`Button error ${interaction.customId}: ${error.message}`);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: t('errors.button_failed'), ephemeral: true });
      } else {
        await interaction.reply({ content: t('errors.button_failed'), ephemeral: true });
      }
    } catch {
      // Interaction expired or already fully acknowledged
    }
  }
}

async function handleResumeQueueButton(interaction, t) {
  const guildId = interaction.customId.split(':')[1] || interaction.guildId;
  
  // Check voice channel
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: t('common.voice_required'), ephemeral: true });
  }

  // Check cache exists
  if (!client.queueCache?.hasCache(guildId)) {
    return interaction.reply({ ...v2Reply({ color: 0xff6b6b, title: `<a:panic:1451081526522417252> ${t('commands.resumequeue.no_cache_title')}`, description: t('commands.resumequeue.no_cache_description') }), ephemeral: true });
  }

  // Disable the button after click
  try {
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`resumequeue:${guildId}`)
        .setLabel(t('errors.node_down_recover_button') || 'Recover Queue')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄')
        .setDisabled(true)
    );
    await interaction.update({ components: [disabledRow] });
  } catch {
    // If update fails, just defer
    await interaction.deferReply();
  }

  const cachedTracks = client.queueCache.getQueue(guildId);
  if (!cachedTracks?.length) {
    return interaction.followUp({ ...v2Reply({ color: 0xff6b6b, title: `<a:panic:1451081526522417252> ${t('commands.resumequeue.no_cache_title')}`, description: t('commands.resumequeue.no_cache_description') }), ephemeral: true });
  }

  // Check bot permissions
  const botMember = interaction.guild.members.me;
  if (!voiceChannel.permissionsFor(botMember).has(['Connect', 'Speak', 'ViewChannel'])) {
    return interaction.followUp({ ...v2Reply({ color: 0xFF0000, title: `<a:dance_teto:1451252227133018374> ${t('common.no_voice_permissions_title') || 'Missing Permissions'}`, description: t('common.no_voice_permissions') }), ephemeral: true });
  }

  // Check for available nodes
  const hasAvailableNode = Array.from(client.kazagumo.shoukaku.nodes.values()).some(n => n.state === 1);
  if (!hasAvailableNode) {
    return interaction.followUp({ ...v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.lavalink_error_title')}`, description: t('errors.lavalink_error_description') }), ephemeral: true });
  }

  let player = client.kazagumo.players.get(guildId);

  // Check for ghost player
  if (player && player.shoukaku?.node?.state !== 1) {
    try {
      await player.destroy();
      player = null;
    } catch {
      client.kazagumo.players.delete(guildId);
      player = null;
    }
  }

  const hadActivePlayer = Boolean(player && (player.queue.length || player.playing || player.paused));
  const preferredNodeName = client.lavalinkMonitor?.getLeastUsedNodeName?.();

  // Create player if doesn't exist
  if (!player) {
    const playerOptions = {
      guildId: guildId,
      voiceId: voiceChannel.id,
      textId: interaction.channelId,
      deaf: true,
      volume: 100
    };
    if (preferredNodeName) {
      playerOptions.nodeName = preferredNodeName;
    }

    try {
      player = await client.kazagumo.createPlayer(playerOptions);
    } catch (error) {
      if (preferredNodeName) {
        delete playerOptions.nodeName;
        player = await client.kazagumo.createPlayer(playerOptions);
      } else {
        throw error;
      }
    }
  } else {
    if (player.voiceId !== voiceChannel.id) {
      player.setVoiceChannel(voiceChannel.id);
    }
    player.setTextChannel(interaction.channelId);
  }

  // Show loading
  await interaction.followUp(v2Reply({ color: 0xF53F5F, description: `# <a:unadance:1450689460307230760> ${t('commands.resumequeue.loading') || 'Restoring queue...'}` }));

  // Resolve tracks
  let addedCount = 0;
  let firstTrack = null;
  let failedCount = 0;

  for (const cached of cachedTracks) {
    try {
      const searchQuery = cached.uri || cached.identifier || `${cached.title} ${cached.author}`;
      if (!searchQuery) {
        failedCount++;
        continue;
      }

      if (addedCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      const result = await client.kazagumo.search(searchQuery, { requester: interaction.user });

      if (result.tracks?.length) {
        const track = result.tracks[0];
        player.queue.add(track);
        addedCount++;

        if (!firstTrack) {
          firstTrack = track;
        }
      } else {
        failedCount++;
      }
    } catch (error) {
      log(`[ResumeQueue Button] Failed to resolve track: ${cached.title}`, error.message);
      failedCount++;

      if (error?.message?.includes('Lavalink') || error?.name === 'RestError') {
        break;
      }
    }
  }

  if (addedCount === 0) {
    if (!hadActivePlayer && player) {
      try {
        await player.destroy();
      } catch {
        client.kazagumo.players.delete(guildId);
      }
    }
    return interaction.editReply(v2Reply({ color: 0xff6b6b, title: `<a:panic:1451081526522417252> ${t('commands.resumequeue.failed_title')}`, description: t('commands.resumequeue.failed_description') }));
  }

  // Clear cache after success
  client.queueCache.clearQueue(guildId);

  // Start playing
  if (!player.playing && !player.paused) {
    await player.play();
  }

  // Success embed
  const successPayload = v2Reply({
    color: 0xF53F5F,
    title: `<a:dance_teto:1451252227133018374> ${t('commands.resumequeue.success_title')}`,
    description: t('commands.resumequeue.success_description', { count: addedCount }),
    fields: [
      { name: t('commands.resumequeue.first_track'), value: firstTrack?.title ? `**${firstTrack.title}**` : t('common.unknown'), inline: true },
      { name: t('commands.resumequeue.queue_size'), value: `${player.queue.length}`, inline: true }
    ],
    timestamp: true
  });

  // Delete loading message and send success
  try {
    const loadingMsg = await interaction.fetchReply();
    if (loadingMsg) await loadingMsg.delete();
  } catch {}
  
  return interaction.channel.send(successPayload);
}

// ========== Now Playing Card Generator ==========
const BACKGROUND_PATH = path.join(__dirname, 'public', 'image', 'background.png');
const FONT_PATH = path.join(__dirname, 'public', 'fonts', 'K2D', 'K2D-Bold.ttf');
const FONT_CJK_BOLD = path.join(__dirname, 'public', 'fonts', 'NotoSansJP', 'NotoSansCJKjp-Bold.otf');
const FONT_CJK_REGULAR = path.join(__dirname, 'public', 'fonts', 'NotoSansJP', 'NotoSansCJKjp-Regular.otf');

// Try to register fonts
const { GlobalFonts } = require('@napi-rs/canvas');
try {
  if (fs.existsSync(FONT_PATH)) {
    GlobalFonts.registerFromPath(FONT_PATH, 'K2D');
  }
  if (fs.existsSync(FONT_CJK_BOLD)) {
    GlobalFonts.registerFromPath(FONT_CJK_BOLD, 'Noto Sans CJK JP');
  }
  if (fs.existsSync(FONT_CJK_REGULAR)) {
    GlobalFonts.registerFromPath(FONT_CJK_REGULAR, 'Noto Sans CJK JP');
  }
} catch (e) {
  // Font not available, will use fallback
}

// Source icon URLs (Discord CDN)
const SOURCE_ICONS = {
  youtube: 'https://cdn.discordapp.com/emojis/1483286021297672315.webp',
  ytmusic: 'https://cdn.discordapp.com/emojis/1446620983267037395.webp',
  spotify: 'https://cdn.discordapp.com/emojis/1446621523631931423.webp',
  deezer: 'https://cdn.discordapp.com/emojis/1483286023604670674.webp',
  applemusic: 'https://cdn.discordapp.com/emojis/1483286022401036408.webp',
  soundcloud: 'https://cdn.discordapp.com/emojis/1483286020005826660.webp',
  twitch: 'https://cdn.discordapp.com/emojis/1483286084514484286.webp'
};

// Positions based on your Figma template (2x scale: 3120x784)
// Cover: 60px vertical margin at 1560 scale = 120px at 3120, size ~272 at 1560 = 544 at 3120
const CARD_POSITIONS = {
  thumb: { x: 120, y: 120, size: 544 },
  title: { x: 720, y: 120 },
  artist: { x: 720, y: 300 },
  duration: { x: 720, y: 0 },  // y calculated dynamically (bottom-aligned with thumb)
  sourceIcon: { x: 2804, y: 120, size: 120 }
};

// Helper to extract string from track property (handles nested info object)
function getTrackString(track, prop) {
  if (!track) return 'Unknown';
  
  // Direct property access
  let value = track[prop];
  
  // If value is an object with a specific structure, extract the string
  if (value && typeof value === 'object') {
    // Try common nested properties
    if (typeof value.name === 'string') return value.name;
    if (typeof value.title === 'string') return value.title;
    if (typeof value.text === 'string') return value.text;
    // Try info.property
    if (track.info && typeof track.info[prop] === 'string') {
      return track.info[prop];
    }
    // Last resort - don't use toString on objects
    return 'Unknown';
  }
  
  // If undefined, try info.property
  if (value === undefined || value === null) {
    value = track.info?.[prop];
  }
  
  // Return as string or Unknown
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return 'Unknown';
}

// Cached background image
let cachedBackground = null;

async function generateNowPlayingCard(track, player) {
  // Load and cache background
  if (!cachedBackground) {
    try {
      cachedBackground = await loadImage(BACKGROUND_PATH);
    } catch (e) {
      log(`[NowPlaying] Failed to load background: ${e.message}`);
    }
  }

  // Use background dimensions or fallback
  const width = cachedBackground?.width ?? 3120;
  const height = cachedBackground?.height ?? 784;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // === BACKGROUND ===
  if (cachedBackground) {
    ctx.drawImage(cachedBackground, 0, 0, width, height);
  } else {
    // Fallback gradient
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#1a0a1a');
    gradient.addColorStop(1, '#2d1a2d');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  // Font family (K2D with CJK fallback)
  const fontFamily = '"K2D", "Noto Sans CJK JP", "Segoe UI", Arial, sans-serif';

  // === THUMBNAIL ===
  let thumbnail = track.thumbnail ?? track.artworkUrl ?? null;
  if (thumbnail) {
    // Get high quality for YouTube
    if (track.sourceName === 'youtube') {
      thumbnail = thumbnail
        .replace('/default.jpg', '/maxresdefault.jpg')
        .replace('/mqdefault.jpg', '/maxresdefault.jpg')
        .replace('/hqdefault.jpg', '/maxresdefault.jpg')
        .replace('/sddefault.jpg', '/maxresdefault.jpg');
    }
    try {
      const thumbImg = await loadImage(thumbnail);
      const { x, y, size } = CARD_POSITIONS.thumb;
      // Rounded corners
      ctx.save();
      roundRect(ctx, x, y, size, size, 32);
      ctx.clip();
      ctx.drawImage(thumbImg, x, y, size, size);
      ctx.restore();
    } catch (e) {
      // Fallback: draw placeholder
      const { x, y, size } = CARD_POSITIONS.thumb;
      ctx.fillStyle = '#333';
      roundRect(ctx, x, y, size, size, 32);
      ctx.fill();
    }
  }

  const maxTextWidth = CARD_POSITIONS.sourceIcon.x - CARD_POSITIONS.title.x - 100;
  const thumbTop = CARD_POSITIONS.thumb.y;
  const thumbBottom = CARD_POSITIONS.thumb.y + CARD_POSITIONS.thumb.size;

  // === TITLE === (aligned with top of thumbnail)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 154px ${fontFamily}`;
  ctx.textBaseline = 'top';
  const titleText = String(track.title ?? track.info?.title ?? 'Unknown');
  const title = truncateCanvasText(ctx, titleText, maxTextWidth);
  ctx.fillText(title, CARD_POSITIONS.title.x, thumbTop);

  // === ARTIST === (below title)
  ctx.fillStyle = '#F53F5F';
  ctx.font = `90px ${fontFamily}`;
  ctx.textBaseline = 'top';
  const artistText = String(track.author ?? track.info?.author ?? 'Unknown');
  const artist = truncateCanvasText(ctx, artistText, maxTextWidth);
  ctx.fillText(artist, CARD_POSITIONS.artist.x, thumbTop + 170);

  // === WEBSITE === (aligned with bottom of thumbnail, where duration used to be)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 72px ${fontFamily}`;
  ctx.textBaseline = 'bottom';
  ctx.fillText('www.kennyy.com.br', CARD_POSITIONS.duration.x, thumbBottom);

  // === SOURCE ICON (tinted with #F53F5F) ===
  const sourceKey = detectTrackSource(track);
  const iconUrl = SOURCE_ICONS[sourceKey];
  if (iconUrl) {
    try {
      const iconImg = await loadImage(iconUrl);
      const { x, y, size } = CARD_POSITIONS.sourceIcon;
      // Draw icon to a temporary canvas and tint it
      const iconCanvas = createCanvas(size, size);
      const iconCtx = iconCanvas.getContext('2d');
      iconCtx.drawImage(iconImg, 0, 0, size, size);
      // Apply tint: draw color on top using source-atop to only color non-transparent pixels
      iconCtx.globalCompositeOperation = 'source-atop';
      iconCtx.fillStyle = '#F53F5F';
      iconCtx.fillRect(0, 0, size, size);
      // Draw tinted icon onto main canvas
      ctx.drawImage(iconCanvas, x, y, size, size);
    } catch (e) {
      // Icon failed to load, skip
    }
  }

  return canvas.toBuffer('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncateCanvasText(ctx, text, maxWidth) {
  if (!text) return '';
  let truncated = text;
  while (ctx.measureText(truncated).width > maxWidth && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  if (truncated.length < text.length) {
    truncated = truncated.slice(0, -3) + '...';
  }
  return truncated;
}

async function buildNowPlayingMessage(player, track, t) {
  if (!track) {
    return {
      payload: {
        content: t('now_playing.no_track'),
        embeds: [],
        components: [],
        files: []
      },
      cardBuffer: null
    };
  }

  const durationMs = Number.isFinite(track.duration) ? track.duration : track.length ?? 0;

  // Generate now playing card image
  const cardBuffer = await generateNowPlayingCard(track, player);
  const attachment = new AttachmentBuilder(cardBuffer, { name: 'nowplaying.png' });

  // Build Components V2 layout
  const container = new ContainerBuilder()
    .setAccentColor(0xF53F5F);

  // "Now Playing" header with emoji (large heading)
  const nowPlayingHeader = `# <:nowplaying:1483257820219576414> ${t('common.now_playing')}`;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(nowPlayingHeader));

  // Image gallery with the now playing card
  const gallery = new MediaGalleryBuilder()
    .addItems(new MediaGalleryItemBuilder().setURL('attachment://nowplaying.png'));
  container.addMediaGalleryComponents(gallery);

  // Info text
  const requester = track.requester;
  const requesterTag = requester?.toString?.() ?? (requester?.id ? `<@${requester.id}>` : t('common.unknown'));
  const statusText = player.paused ? t('status.paused') : t('status.playing');
  const progressBar = buildProgressField(player.position, durationMs);

  const infoLines = [
    `<:volume:1483280753528668280> **${t('common.volume')}:** ${player.volume ?? 100}%`,
    `<:queue:1483280662663401502> **${t('common.queue_label')}:** ${t('now_playing.queue_value', { count: player.queue.length })}`,
    `<:status:1483280661270757548> **${t('common.status')}:** ${statusText}`,
    `<:request:1483280660432162847> **${t('common.requested_by')}:** ${requesterTag}`,
    '',
    progressBar
  ].join('\n');

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(infoLines));

  // Separator before buttons
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

  // Buttons in action rows
  const buttonRows = buildPlaybackComponents(player, t);
  for (const row of buttonRows) {
    container.addActionRowComponents(row);
  }

  return {
    payload: {
      components: [container],
      files: [attachment],
      flags: MessageFlags.IsComponentsV2
    },
    cardBuffer
  };
}

function buildPlaybackComponents(player, t) {
  const isPaused = player.paused;
  const loopMode = getLoopMode(player);
  const loopLabels = {
    none: t('loop.off'),
    track: t('loop.track'),
    queue: t('loop.queue')
  };
  const loopLabel = loopLabels[loopMode] ?? loopLabels.none;
  const loopStyle = loopMode === 'none' ? ButtonStyle.Secondary : ButtonStyle.Success;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music-volume-down').setEmoji({ id: '1482495400782069966', name: '1_volumedown' }).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music-volume-up').setEmoji({ id: '1482495442070540308', name: '2_volumeup' }).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music-playpause')
        .setEmoji(isPaused ? { id: '1482495548249608197', name: '3_play' } : { id: '1482495598576799794', name: '3_pause' })
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music-skip').setEmoji({ id: '1482495649994772580', name: '4_skip' }).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music-stop').setEmoji({ id: '1482495681691128018', name: '5_stop' }).setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('music-shuffle')
        .setEmoji({ id: '1482495731498750152', name: '6_shuffle' })
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music-loop')
        .setEmoji({ id: '1482495766269526126', name: '7_loop' })
        .setLabel(loopLabel)
        .setStyle(loopStyle),
      new ButtonBuilder()
        .setCustomId('music-lyrics')
        .setEmoji({ id: '1482495799408722162', name: '8_lyrics' })
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function handleQueueButton(interaction, player, t) {
  const state = client.queueState.get(interaction.message?.id) || { page: 0, perPage: 10 };
  const command = interaction.customId;

  const replyNoTrack = async () => interaction.reply({ content: t('common.no_player'), ephemeral: true });

  if (!player?.queue) {
    return replyNoTrack();
  }

  const applyAndUpdate = async (mutator = () => {}) => {
    mutator();
    await updateQueueMessage(interaction, player, state, t);
  };

  try {
    switch (command) {
      case 'queue_prev_page': {
        await applyAndUpdate(() => {
          state.page = Math.max(0, state.page - 1);
        });
        break;
      }
      case 'queue_next_page': {
        await applyAndUpdate(() => {
          state.page += 1;
        });
        break;
      }
      case 'queue_stop_lyrics': {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate();
        }
        await stopLyrics(player, { deleteMessage: true });
        break;
      }
      case 'queue_close': {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate();
        }
        client.queueState?.delete?.(interaction.message?.id);
        try {
          await interaction.message?.delete?.();
        } catch (error) {
          log(`Failed to delete queue message: ${error.message}`);
        }
        break;
      }
      default: {
        return interaction.reply({ content: t('errors.button_unknown'), ephemeral: true });
      }
    }
  } catch (error) {
    log(`Queue button error ${command}: ${error.message}`);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: t('errors.button_failed'), ephemeral: true });
    } else {
      await interaction.followUp({ content: t('errors.button_failed'), ephemeral: true });
    }
  }
}

async function handleFilterButton(interaction, player, t) {
  const state = getFilterState(player);
  const command = interaction.customId;

  const ensureDeferred = async () => {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  };

  const notify = async key => {
    try {
      await interaction.followUp({ content: t(key), ephemeral: true });
    } catch (error) {
      log(`Failed to send filter notice: ${error.message}`);
    }
  };

  const toggleFilter = async (filterKey, enable) => {
    if (enable) {
      state.active.add(filterKey);
    } else {
      state.active.delete(filterKey);
      if (filterKey === 'bass_boost') {
        state.bassLevel = null;
      }
    }
    storeFilterState(player, state);
    await applyFilterState(player, state);
    await updateFilterMessage(interaction.client, state, t, interaction.message, player);
  };

  try {
    switch (command) {
      case 'filter_bass_boost': {
        if (state.active.has('bass_boost')) {
          await ensureDeferred();
          await toggleFilter('bass_boost', false);
          await notify('commands.filter.buttons.bass_boost.deactivated');
          break;
        }

        const components = buildBassLevelComponents(t);
        return interaction.reply({
          content: t('commands.filter.buttons.bass_boost.select_level'),
          components,
          ephemeral: true
        });
      }
      case 'filter_bass_low':
      case 'filter_bass_medium':
      case 'filter_bass_high': {
        const level = command.replace('filter_bass_', '');
        state.active.add('bass_boost');
        state.bassLevel = level;
        storeFilterState(player, state);
        await applyFilterState(player, state);
        await updateFilterMessage(interaction.client, state, t, interaction.message, player);
        const key = `commands.filter.buttons.bass_boost.activated_${level}`;
        try {
          await interaction.update({ content: t(key), components: [] });
        } catch (error) {
          log(`Failed to update bass level selection: ${error.message}`);
        }
        break;
      }
      case 'filter_nightcore': {
        const enable = !state.active.has('nightcore');
        await ensureDeferred();
        await toggleFilter('nightcore', enable);
        await notify(enable ? 'commands.filter.buttons.nightcore.activated' : 'commands.filter.buttons.nightcore.deactivated');
        break;
      }
      case 'filter_karaoke': {
        const enable = !state.active.has('karaoke');
        await ensureDeferred();
        await toggleFilter('karaoke', enable);
        await notify(enable ? 'commands.filter.buttons.karaoke.activated' : 'commands.filter.buttons.karaoke.deactivated');
        break;
      }
      case 'filter_rotation': {
        const enable = !state.active.has('rotation');
        await ensureDeferred();
        await toggleFilter('rotation', enable);
        await notify(enable ? 'commands.filter.buttons.rotation.activated' : 'commands.filter.buttons.rotation.deactivated');
        break;
      }
      case 'filter_reset': {
        await ensureDeferred();
        state.active.clear();
        state.bassLevel = null;
        storeFilterState(player, state);
        await applyFilterState(player, state);
        await updateFilterMessage(interaction.client, state, t, interaction.message, player);
        await notify('commands.filter.buttons.reset.success');
        break;
      }
      default: {
        return interaction.reply({ content: t('errors.button_unknown'), ephemeral: true });
      }
    }
  } catch (error) {
    log(`Filter button error ${command}: ${error.message}`);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: t('errors.button_failed'), ephemeral: true });
    } else {
      await interaction.followUp({ content: t('errors.button_failed'), ephemeral: true });
    }
  }
}

async function updateQueueMessage(interaction, player, state, t) {
  const perPage = state.perPage || 10;
  const queuePayload = buildQueueEmbed(player, state.page, perPage, t);
  const navComponents = buildQueueComponents(state.page, perPage, player, t);
  // Inject nav buttons into the V2 container
  queuePayload.components[0].addActionRowComponents(...navComponents);

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
    await interaction.message.edit(queuePayload);
    client.queueState.set(interaction.message.id, { ...state });
  } catch (error) {
    log(`Failed to update queue message: ${error.message}`);
  }
}

function buildQueueComponents(page, perPage, player, t) {
  const items = getQueueItems(player);
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));
  const clampedPage = Math.max(0, Math.min(page, pageCount - 1));

  const prevDisabled = pageCount <= 1 || clampedPage <= 0;
  const nextDisabled = pageCount <= 1 || clampedPage >= pageCount - 1;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('queue_prev_page').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(prevDisabled),
      new ButtonBuilder().setCustomId('queue_next_page').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(nextDisabled),
      new ButtonBuilder().setCustomId('queue_close').setEmoji('❌').setStyle(ButtonStyle.Primary)
    )
  ];
}

function buildQueueEmbed(player, page, perPage, t) {
  if (!player) {
    return v2Reply({ color: 0xF53F5F, title: t('queue.title'), description: t('common.no_player') });
  }

  const current = player.queue?.current;
  const items = getQueueItems(player);
  const total = items.length;

  if (!current && total === 0) {
    return v2Reply({ color: 0xF53F5F, title: t('queue.title'), description: t('queue.empty') });
  }

  const fields = [];
  let descParts = [];

  if (current) {
    const durationMs = Number.isFinite(current.duration) ? current.duration : current.length ?? 0;
    const progress = buildProgressField(player.position, durationMs);
    const statusText = player.paused ? t('status.paused') : t('status.playing');

    fields.push(
      { name: t('common.now_playing'), value: `**${current.title ?? t('common.unknown')}**` },
      { name: t('common.artist'), value: current.author ?? t('common.unknown') },
      { name: t('common.duration'), value: formatDuration(durationMs) },
      { name: t('common.status'), value: statusText },
      { name: t('common.progress'), value: progress }
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const clampedPage = Math.max(0, Math.min(page, pageCount - 1));
  const start = clampedPage * perPage;
  const end = start + perPage;
  const pageItems = items.slice(start, end);

  const lines = pageItems.map((track, index) => {
    const num = start + index + 1;
    const title = truncateText(track.title ?? t('common.unknown'), 45);
    const duration = formatDuration(track.duration ?? track.length ?? 0);
    return `\`${num}.\` ${title} (${duration})`;
  });

  if (lines.length) {
    fields.push({ name: t('queue.field_next') ?? 'Up Next', value: lines.join('\n') });
  } else if (total > 0) {
    fields.push({ name: t('queue.field_next') ?? 'Up Next', value: t('queue.empty') });
  }

  fields.push(
    { name: t('queue.total') ?? 'Total tracks', value: String(total) },
    { name: t('queue.page') ?? 'Page', value: `${clampedPage + 1}/${pageCount}` }
  );

  return v2Reply({ color: 0xF53F5F, title: t('queue.title'), fields, timestamp: true });
}

function truncateText(text, limit) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function getQueueItems(player) {
  const q = player?.queue;
  if (!q) return [];
  if (Array.isArray(q)) return q;
  if (Array.isArray(q.tracks)) return q.tracks;
  if (typeof q.toArray === 'function') return q.toArray();
  try {
    return Array.from(q);
  } catch (error) {
    return [];
  }
}

client.queueHelpers = {
  buildQueueEmbed,
  buildQueueComponents
};

function getFilterState(player) {
  const raw = player?.data?.get('filterState');
  const active = new Set(raw?.active ?? []);
  return {
    active,
    bassLevel: raw?.bassLevel ?? null,
    messageId: raw?.messageId ?? null,
    channelId: raw?.channelId ?? null
  };
}

function storeFilterState(player, state) {
  if (!player?.data) return;
  player.data.set('filterState', {
    active: Array.from(state.active ?? []),
    bassLevel: state.bassLevel ?? null,
    messageId: state.messageId ?? null,
    channelId: state.channelId ?? null
  });
}

function buildFilterEmbed(player, t) {
  const current = player.queue?.current;
  return v2Reply({
    color: 0xF53F5F,
    title: t('commands.filter.filters.embed.title'),
    description: t('commands.filter.filters.embed.description'),
    fields: [
      {
        name: t('commands.filter.filters.embed.now_playing_label'),
        value: t('commands.filter.filters.embed.now_playing_value', {
          title: current?.title ?? t('common.unknown'),
          author: current?.author ?? t('common.unknown')
        })
      },
      {
        name: t('commands.filter.filters.embed.available_label'),
        value: t('commands.filter.filters.embed.available_value')
      },
      {
        name: t('commands.filter.filters.embed.howto_label'),
        value: t('commands.filter.filters.embed.howto_value')
      }
    ],
    footer: t('commands.filter.filters.embed.footer')
  });
}

function buildFilterComponents(state, t) {
  const active = state?.active ?? new Set();
  const bassActive = active.has('bass_boost');
  const nightcoreActive = active.has('nightcore');
  const karaokeActive = active.has('karaoke');
  const rotationActive = active.has('rotation');

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('filter_bass_boost')
        .setEmoji('🎵')
        .setLabel(t('commands.filter.buttons.bass_boost.label'))
        .setStyle(bassActive ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('filter_nightcore')
        .setEmoji('⚡')
        .setLabel(t('commands.filter.buttons.nightcore.label'))
        .setStyle(nightcoreActive ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('filter_karaoke')
        .setEmoji('🎤')
        .setLabel(t('commands.filter.buttons.karaoke.label'))
        .setStyle(karaokeActive ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('filter_rotation')
        .setEmoji('🌀')
        .setLabel(t('commands.filter.buttons.rotation.label'))
        .setStyle(rotationActive ? ButtonStyle.Primary : ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('filter_reset')
        .setEmoji('🔄')
        .setLabel(t('commands.filter.buttons.reset.label'))
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

async function applyFilterState(player, state) {
  if (!player?.shoukaku) return;

  const filters = {
    volume: 1,
    equalizer: [],
    karaoke: null,
    timescale: null,
    rotation: null
  };

  if (state.active.has('bass_boost')) {
    const level = state.bassLevel && BASSBOOST_LEVELS[state.bassLevel] ? state.bassLevel : 'medium';
    filters.equalizer = BASSBOOST_LEVELS[level];
  }

  if (state.active.has('nightcore')) {
    filters.timescale = { speed: 1.25, pitch: 1.3, rate: 1.0 };
  }

  if (state.active.has('karaoke')) {
    filters.karaoke = { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 };
  }

  if (state.active.has('rotation')) {
    filters.rotation = { rotationHz: 0.2 };
  }

  try {
    await player.shoukaku.setFilters(filters);
  } catch (error) {
    log(`Failed to apply filters: ${error.message}`);
  }
}

function buildBassLevelComponents(t) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('filter_bass_low')
        .setEmoji('🔉')
        .setLabel(t('commands.filter.buttons.bass_boost.level_low'))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('filter_bass_medium')
        .setEmoji('🔊')
        .setLabel(t('commands.filter.buttons.bass_boost.level_medium'))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('filter_bass_high')
        .setEmoji('📢')
        .setLabel(t('commands.filter.buttons.bass_boost.level_high'))
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function updateFilterMessage(client, state, t, messageHint = null, player = null) {
  if (!state?.messageId || !state?.channelId) return;
  const components = buildFilterComponents(state, t);
  let targetMessage = null;

  if (messageHint?.id === state.messageId) {
    targetMessage = messageHint;
  }

  if (!targetMessage) {
    try {
      const channel = client.channels.cache.get(state.channelId) || (await client.channels.fetch(state.channelId));
      if (channel?.messages?.fetch) {
        targetMessage = await channel.messages.fetch(state.messageId);
      }
    } catch (error) {
      log(`Failed to fetch filter message: ${error.message}`);
      return;
    }
  }

  if (!targetMessage) return;

  try {
    if (player) {
      const filterPayload = buildFilterEmbed(player, t);
      filterPayload.components[0].addActionRowComponents(...components);
      await targetMessage.edit(filterPayload);
    } else {
      await targetMessage.edit({ components });
    }
  } catch (error) {
    log(`Failed to update filter message: ${error.message}`);
  }
}

client.filterHelpers = {
  buildFilterEmbed,
  buildFilterComponents,
  getFilterState,
  storeFilterState
};

async function refreshNowPlayingMessage(player) {
  const message = player.data.get('nowPlayingMessage');
  if (!message) return;
  const track = player.queue.current;
  const t = await getTranslator(client, player.guildId);
  if (!track) {
    try {
      await message.delete();
    } catch {
      // If can't delete, just ignore
    }
    player.data.delete('nowPlayingMessage');
    return;
  }
  const { payload } = await buildNowPlayingMessage(player, track, t);
  await message.edit(payload);
}

function startProgressUpdater(player) {
  cleanupProgressUpdater(player);
  const interval = setInterval(() => refreshNowPlayingMessage(player).catch(() => {}), 15000);
  player.data.set('npInterval', interval);
}

function cleanupProgressUpdater(player) {
  const interval = player.data.get('npInterval');
  if (interval) {
    clearInterval(interval);
    player.data.delete('npInterval');
  }
}

async function handleLyricsButton(interaction, player, t) {
  const track = player.queue.current;
  if (!track) {
    return interaction.reply({ content: t('lyrics.no_track'), ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: false });

  const searchingPayload = v2Reply({ color: 0xF53F5F, title: t('lyrics.searching_title'), description: t('lyrics.searching_description', { song: track.title }), footer: t('lyrics.searching_footer') });

  const message = await interaction.editReply(searchingPayload);
  player.data.set('lyricsMessage', message);

  const lyricsData = await fetchLyrics(track);

  if (!lyricsData) {
    const notFoundPayload = v2Reply({ color: 0xff0000, title: t('lyrics.not_found_title'), description: t('lyrics.not_found_description', { query: `${track.title} - ${track.author}` }) });
    return interaction.editReply(notFoundPayload);
  }

  const timedLines = lyricsData.timedLines || [];
  const positionMs = getApproxPositionMs(player, track);
  const currentIndex = timedLines.length > 0 ? findLineIndex(timedLines, positionMs) : null;
  const snippet = timedLines.length > 0 ? renderTimedSnippet(timedLines, currentIndex) : null;

  const description = snippet || lyricsData.lyrics || t('lyrics.empty');

  const lyricsReply = createLyricsPayload(track, lyricsData, description, t);
  await interaction.editReply(lyricsReply);

  if (timedLines.length > 0) {
    startLyricsSync(player, message, track, lyricsData, t);
  }
}

async function handleLyricsStop(interaction, player, t) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }
  await stopLyrics(player, { deleteMessage: true });
  try {
    await interaction.followUp({ content: t('lyrics.stopped'), ephemeral: true });
  } catch (error) {
    log(`Failed to send lyrics stop follow-up: ${error.message}`);
  }
}

function createLyricsPayload(track, lyricsData, description, t) {
  if (description.length > 4000) {
    description = description.substring(0, 3997) + '...';
  }

  const artistLine = lyricsData.artist || track.author;
  const title = t('lyrics.embed_title', { title: lyricsData.title || track.title });
  const footer = t('lyrics.embed_footer', { track: track.title, source: lyricsData.source || '?' });
  const body = artistLine ? `-# ${artistLine}\n\n${description}` : description;

  const stopRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lyrics_stop')
      .setEmoji('🛑')
      .setLabel(t('lyrics.stop_button') ?? 'Stop')
      .setStyle(ButtonStyle.Danger)
  );

  return v2Reply({ color: 0xF53F5F, title, description: body, footer, components: [stopRow] });
}

function startLyricsSync(player, message, track, lyricsData, t) {
  const existingInterval = player.data.get('lyricsInterval');
  if (existingInterval) {
    clearInterval(existingInterval);
  }

  const timedLines = lyricsData.timedLines;
  let lastIndex = null;
  let consecutiveFailures = 0;

  const interval = setInterval(async () => {
    try {
      const currentTrack = player.queue.current;
      if (!currentTrack || currentTrack.identifier !== track.identifier) {
        clearInterval(interval);
        player.data.delete('lyricsInterval');
        return;
      }

      if (!player.playing && !player.paused) {
        clearInterval(interval);
        player.data.delete('lyricsInterval');
        return;
      }

      const positionMs = getApproxPositionMs(player, track);
      const currentIndex = findLineIndex(timedLines, positionMs);

      if (currentIndex !== null && currentIndex !== lastIndex) {
        const snippet = renderTimedSnippet(timedLines, currentIndex);
        if (snippet) {
          const payload = createLyricsPayload(track, lyricsData, snippet, t);
          try {
            await message.edit(payload);
            consecutiveFailures = 0;
          } catch (error) {
            if (error.code === 10008) {
              clearInterval(interval);
              player.data.delete('lyricsInterval');
              return;
            }
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
              clearInterval(interval);
              player.data.delete('lyricsInterval');
              return;
            }
          }
          lastIndex = currentIndex;
        }
      }
    } catch (error) {
      log(`[Lyrics] Sync error: ${error.message}`);
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        clearInterval(interval);
        player.data.delete('lyricsInterval');
      }
    }
  }, 1000);

  player.data.set('lyricsInterval', interval);
}

async function stopLyrics(player, options = {}) {
  const { deleteMessage = false } = options;
  const interval = player?.data?.get?.('lyricsInterval');
  if (interval) {
    clearInterval(interval);
    player.data.delete('lyricsInterval');
  }

  if (deleteMessage) {
    const lyricsMessage = player?.data?.get?.('lyricsMessage');
    if (lyricsMessage) {
      try {
        if (!lyricsMessage.deleted) {
          await lyricsMessage.delete();
        }
      } catch (error) {
        log(`Failed to delete lyrics message: ${error.message}`);
      }
      player.data.delete('lyricsMessage');
    }
  }
}

async function deleteNowPlayingEmbed(player) {
  const message = player?.data?.get('nowPlayingMessage');
  if (!message) return;
  try {
    if (message.deleted) {
      player.data.delete('nowPlayingMessage');
      return;
    }
    if (message.deletable) {
      await message.delete();
    } else {
      await message.edit({ content: ' ', embeds: [], components: [] });
    }
  } catch (error) {
    log(`Failed to remove embed: ${error.message}`);
  }
  player.data.delete('nowPlayingMessage');
}

function buildQueueDescription(player, t) {
  if (!player.queue.length) {
    return t('queue.empty');
  }
  return player.queue
    .slice(0, 10)
    .map((track, index) => {
      const duration = track?.duration ?? track?.length ?? 0;
      return `${index + 1}. ${track.title} • ${formatDuration(duration)}`;
    })
    .join('\n');
}

function formatDuration(ms) {
  if (!ms || Number.isNaN(ms)) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sendLogChannel(message) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  channel.send({ content: message }).catch(() => {});
}

async function sendMusicStartLog(player, track, cardBuffer) {
  if (!track || !client.logSettingsStore) {
    return;
  }

  const channelId = (process.env.LOG_CHANNEL_ID || '').trim();
  if (!channelId) {
    return;
  }

  let enabled = false;
  try {
    enabled = await client.logSettingsStore.isMusicLogsEnabled();
  } catch (error) {
    log(`[Logs] Failed to check music log status: ${error.message}`);
    return;
  }

  if (!enabled) {
    return;
  }

  let logChannel = client.channels.cache.get(channelId);
  if (!logChannel) {
    try {
      logChannel = await client.channels.fetch(channelId);
    } catch (error) {
      log(`[Logs] Failed to fetch log channel: ${error.message}`);
      return;
    }
  }

  if (!logChannel?.isTextBased?.()) {
    return;
  }

  const trackTitle = track.title ?? 'Unknown';
  const trackUrl = track.uri ?? track.realUri ?? null;
  const trackValue = trackUrl ? `[${trackTitle}](${trackUrl})` : trackTitle;

  const guild = client.guilds.cache.get(player.guildId);
  const guildLabel = guild ? `${guild.name} (${guild.id})` : player.guildId ?? 'Unknown';

  const voiceChannelId = player.voiceId ?? player.connection?.channelId;
  const voiceChannel = voiceChannelId ? client.channels.cache.get(voiceChannelId) : null;
  const voiceLabel = voiceChannel?.name ?? 'Unknown';

  const requesterLabel = formatRequesterLabel(track.requester);

  try {
    // Reuse the card buffer from Now Playing (no duplicate generation)
    const attachment = cardBuffer
      ? new AttachmentBuilder(cardBuffer, { name: 'logcard.png' })
      : null;

    const container = new ContainerBuilder().setAccentColor(0xF53F5F);

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🎵 Music started'));

    if (attachment) {
      const gallery = new MediaGalleryBuilder()
        .addItems(new MediaGalleryItemBuilder().setURL('attachment://logcard.png'));
      container.addMediaGalleryComponents(gallery);
    }

    const fieldsText = [
      `**Track** ${trackValue || 'Unknown'} ​ ​ **Server** ${guildLabel || 'Unknown'}`,
      `**Voice Channel** ${voiceLabel} ​ ​ **Requested By** ${requesterLabel}`,
      '',
      `-# <t:${Math.floor(Date.now() / 1000)}:R>`
    ].join('\n');
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(fieldsText));

    await logChannel.send({
      components: [container],
      files: attachment ? [attachment] : [],
      flags: MessageFlags.IsComponentsV2
    });
  } catch (error) {
    log(`[Logs] Failed to send music log: ${error.message}`);
  }
}

function formatRequesterLabel(requester) {
  if (!requester) {
    return 'Unknown';
  }
  if (typeof requester === 'string') {
    return requester;
  }
  if (typeof requester.tag === 'string') {
    return requester.tag;
  }
  if (typeof requester.username === 'string') {
    const discrim = requester.discriminator && requester.discriminator !== '0' ? `#${requester.discriminator}` : '';
    return `${requester.username}${discrim}`;
  }
  if (requester.id) {
    return `<@${requester.id}>`;
  }
  try {
    return JSON.stringify(requester);
  } catch (error) {
    return String(requester);
  }
}

function buildProgressField(position = 0, duration = 0) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safePosition = Math.max(0, position || 0);
  const percent = safeDuration ? Math.min(safePosition / safeDuration, 1) : 0;
  const barLength = 25;
  const filled = Math.min(barLength, Math.floor(barLength * percent));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, barLength - filled))}`;
  const currentTime = formatDuration(safePosition);
  const totalTime = formatDuration(safeDuration);
  return `\`${currentTime}\` ${bar} \`${totalTime}\``;
}

function detectTrackSource(track) {
  if (!track) return null;
  const info = track.info ?? {};
  const source = String(track.sourceName ?? info.sourceName ?? info.source ?? '').toLowerCase();
  const uri = String(track.uri ?? info.uri ?? '').toLowerCase();
  const match = substr => source.includes(substr) || uri.includes(substr);
  if (match('music.youtube') || match('ytm')) return 'ytmusic';
  if (match('youtube') || match('youtu.be')) return 'youtube';
  if (match('deezer')) return 'deezer';
  if (match('spotify')) return 'spotify';
  if (match('apple')) return 'applemusic';
  if (match('soundcloud')) return 'soundcloud';
  if (match('twitch')) return 'twitch';
  return null;
}

function trackSourceIcon(track) {
  const key = detectTrackSource(track);
  return (key && TRACK_SOURCE_ICONS[key]) || '🎵';
}

function trackSourceColor(track) {
  const key = detectTrackSource(track);
  return (key && TRACK_SOURCE_COLORS[key]) || 0x00ff00;
}

function stripLeadingIcons(text) {
  if (!text) return text;
  let sanitized = text.replace(/^(<:[^:>]+:\d+>\s*)+/g, '');
  sanitized = sanitized.replace(/^[\u2600-\u27BF\u{1F300}-\u{1FAFF}]+\s*/u, '');
  return sanitized.trim();
}

function setupAntiCrash() {
  if (antiCrashReady) return;
  antiCrashReady = true;

  const isIgnorableAbortError = error => {
    if (!error) return false;
    if (error?.name === 'AbortError') return true;
    const text = stringifyError(error);
    if (typeof text === 'string' && text.includes('AbortError: The operation was aborted')) return true;
    // Shoukaku race condition: Player.update() fires after player is already destroyed
    if (error?.message === 'Player not found.' || (typeof text === 'string' && text.includes('Player not found.'))) return true;
    return false;
  };

  const forward = (type, error) => {
    // Discord.js cancels in-flight gateway operations during reconnect/destroy.
    // Those AbortErrors are expected and should not be treated as crashes.
    if (isIgnorableAbortError(error)) {
      return;
    }

    const detail = formatAntiCrashDetail(error);
    log(`[AntiCrash] ${type}: ${detail.short}`);
    sendLogChannel(`⚠️ AntiCrash • ${type}\n${detail.block}`);
  };

  process.on('unhandledRejection', reason => forward('unhandledRejection', reason));
  process.on('uncaughtException', error => forward('uncaughtException', error));
  process.on('uncaughtExceptionMonitor', error => forward('uncaughtExceptionMonitor', error));
}

function formatAntiCrashDetail(error) {
  const raw = stringifyError(error);
  const truncated = raw.length > 1800 ? `${raw.slice(0, 1800)}…` : raw;
  const firstLine = raw.split('\n')[0] || raw;
  return {
    short: firstLine.trim().slice(0, 200) || 'No details available',
    block: `\n\`\`\`\n${truncated}\n\`\`\``
  };
}

function stringifyError(error) {
  if (!error) return 'No details available';
  if (error instanceof Error) {
    return error.stack || error.message || String(error);
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch (jsonError) {
    return `Failed to serialize error: ${jsonError.message}`;
  }
}

async function attemptReconnectLavalink(client) {
  const shoukaku = client?.kazagumo?.shoukaku;
  if (!shoukaku) return;

  const CONNECTED = Constants?.State?.CONNECTED ?? 1;
  let attempts = 0;

  for (const node of shoukaku.nodes.values()) {
    if (node.state === CONNECTED) continue;
    try {
      node.connect();
      attempts += 1;
      log(`[Lavalink] Reconnecting node ${node.name} after command failure...`);
    } catch (error) {
      log(`[Lavalink] Failed to reconnect node ${node.name}: ${error?.message ?? error}`);
    }
  }

  return attempts;
}

function isLavalinkCommand(name) {
  // Commands that rely on Lavalink playback
  const musicCommands = new Set([
    'play',
    'pause',
    'resume',
    'skip',
    'skipto',
    'stop',
    'shuffle',
    'queue',
    'seek',
    'filters',
    'lyrics'
  ]);
  return musicCommands.has(name);
}

function getLoopMode(player) {
  if (!player) return 'none';
  return player.loop ?? 'none';
}

function cycleLoopMode(player) {
  if (!player) return 'none';
  const next = player.loop === 'none' ? 'track' : player.loop === 'track' ? 'queue' : 'none';
  player.setLoop(next);
  return next;
}

// Lonely pause system - manages auto-pause/disconnect when bot is alone
const aloneTimeouts = new Map();

function countNonBotListeners(channel) {
  if (!channel?.members) return 0;
  let count = 0;
  for (const [, member] of channel.members) {
    if (member.id === client.user?.id) continue;
    if (member.user?.bot) continue;
    count++;
  }
  return count;
}

function getPreferredTextChannel(player, guild) {
  // Try the text channel associated with the player
  const textChannelId = player?.textId;
  if (textChannelId) {
    const channel = guild.channels.cache.get(textChannelId);
    if (channel?.isTextBased?.()) {
      const me = guild.members.me;
      if (me && channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) {
        return channel;
      }
    }
  }

  // Try system channel
  if (guild.systemChannel) {
    const me = guild.members.me;
    if (me && guild.systemChannel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) {
      return guild.systemChannel;
    }
  }

  // Find first available text channel
  const me = guild.members.me;
  for (const [, channel] of guild.channels.cache) {
    if (channel.isTextBased?.() && me && channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) {
      return channel;
    }
  }

  return null;
}

async function activateLonelyPause(guild, player) {
  const voiceChannel = guild.channels.cache.get(player.voiceId);
  if (!voiceChannel) return;

  // Already paused by lonely system
  if (player.data.get('afkPauseActive')) return;

  player.data.set('afkPauseActive', true);

  // Pause if playing
  if (player.playing && !player.paused) {
    try {
      await player.pause(true);
      log(`⏸️ Pausado por ausência em ${guild.name}`);
    } catch (error) {
      log(`❌ Falha ao pausar por ausência: ${error.message}`);
    }
  }

  // Send message
  const textChannel = getPreferredTextChannel(player, guild);
  if (textChannel) {
    try {
      const t = await getTranslator(client, guild.id);
      const title = t('player.lonely.pause_title');
      const message = t('player.lonely.pause', { call: voiceChannel.toString() });
      
      const embed = v2Reply({
        color: 0xF53F5F,
        title: `${process.env.EMOJI_CATCHILL || '<:catchill:1451442818408124557>'} ${title}`,
        description: message,
        timestamp: true
      });
      
      const msg = await textChannel.send(embed);
      // Store message to delete later when user returns or bot disconnects
      player.data.set('lonelyPauseMessage', msg);
    } catch (error) {
      log(`❌ Falha ao enviar aviso de pausa: ${error.message}`);
    }
  }

  // Clear existing timeout if any
  const existingTimeout = aloneTimeouts.get(guild.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Set 2-minute countdown to disconnect
  const timeout = setTimeout(async () => {
    try {
      await lonelyDisconnect(guild.id);
    } catch (error) {
      log(`❌ Erro no countdown de desconexão: ${error.message}`);
    }
  }, 120000); // 2 minutes

  aloneTimeouts.set(guild.id, timeout);
}

async function cancelLonelyPause(guild, player) {
  // Clear timeout
  const timeout = aloneTimeouts.get(guild.id);
  if (timeout) {
    clearTimeout(timeout);
    aloneTimeouts.delete(guild.id);
  }

  // Not in AFK pause
  if (!player.data.get('afkPauseActive')) return;

  player.data.set('afkPauseActive', false);

  // Resume if paused and has track
  if (player.paused && player.queue.current) {
    try {
      await player.pause(false);
      log(`▶️ Retomado após retorno em ${guild.name}`);
    } catch (error) {
      log(`❌ Falha ao retomar: ${error.message}`);
    }
  }

  // Delete pause message if exists
  const pauseMessage = player.data.get('lonelyPauseMessage');
  if (pauseMessage) {
    try {
      await pauseMessage.delete();
      player.data.delete('lonelyPauseMessage');
    } catch (error) {
      // Message might already be deleted
    }
  }

  // Send resume message
  const voiceChannel = guild.channels.cache.get(player.voiceId);
  const textChannel = getPreferredTextChannel(player, guild);
  if (textChannel && voiceChannel) {
    try {
      const t = await getTranslator(client, guild.id);
      const title = t('player.lonely.resume_title');
      const message = t('player.lonely.resume', { call: voiceChannel.toString() });
      
      const resumePayload = v2Reply({
        color: 0xF53F5F,
        title: `${process.env.EMOJI_WINK || '<:7156remwink:1451443034838405330>'} ${title}`,
        description: message,
        timestamp: true
      });
      
      const msg = await textChannel.send(resumePayload);
      setTimeout(() => msg.delete().catch(() => {}), 10000);
    } catch (error) {
      log(`❌ Falha ao enviar aviso de retomada: ${error.message}`);
    }
  }
}

async function lonelyDisconnect(guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const player = client.kazagumo.players.get(guildId);
  if (!player) return;

  const voiceChannel = guild.channels.cache.get(player.voiceId);
  if (!voiceChannel) return;

  // Check if still alone
  if (countNonBotListeners(voiceChannel) > 0) return;

  // Delete pause message if exists
  const pauseMessage = player.data.get('lonelyPauseMessage');
  if (pauseMessage) {
    try {
      await pauseMessage.delete();
      player.data.delete('lonelyPauseMessage');
    } catch (error) {
      // Message might already be deleted
    }
  }

  // Send disconnect message
  const textChannel = getPreferredTextChannel(player, guild);
  if (textChannel) {
    try {
      const t = await getTranslator(client, guild.id);
      const title = t('player.lonely.disconnect_title');
      const message = t('player.lonely.disconnect', { call: voiceChannel.toString() });
      
      const disconnectPayload = v2Reply({
        color: 0xff0000,
        title: `👋 ${title}`,
        description: message,
        timestamp: true
      });
      
      await textChannel.send(disconnectPayload);
    } catch (error) {
      log(`❌ Falha ao enviar aviso de desconexão: ${error.message}`);
    }
  }

  // Clear data
  await deleteNowPlayingEmbed(player);
  await stopLyrics(player, { deleteMessage: true });

  // Disconnect
  try {
    await player.destroy();
    log(`🔌 Desconectado por ausência prolongada em ${guild.name}`);
  } catch (error) {
    log(`❌ Falha ao desconectar: ${error.message}`);
  }

  // Clean up timeout
  aloneTimeouts.delete(guildId);
}

async function evaluateVoiceChannel(guild) {
  if (!guild) return;

  const player = client.kazagumo.players.get(guild.id);
  if (!player) {
    // No player, clear any pending timeout
    const timeout = aloneTimeouts.get(guild.id);
    if (timeout) {
      clearTimeout(timeout);
      aloneTimeouts.delete(guild.id);
    }
    return;
  }

  const voiceChannel = guild.channels.cache.get(player.voiceId);
  if (!voiceChannel) {
    await cancelLonelyPause(guild, player);
    return;
  }

  const listenerCount = countNonBotListeners(voiceChannel);

  if (listenerCount === 0) {
    await activateLonelyPause(guild, player);
  } else {
    await cancelLonelyPause(guild, player);
  }
}
