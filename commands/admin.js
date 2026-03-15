const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getTranslator } = require('../utils/localeHelpers');
const { serializeActivity, buildPresencePayload, sanitizeStatusKey } = require('../utils/presenceStore');

const STATUS_CHOICES = [
  { name: 'Online', value: 'online' },
  { name: 'Do Not Disturb', value: 'dnd' },
  { name: 'Idle', value: 'idle' },
  { name: 'Invisible', value: 'invisible' }
];

const LOG_ACTION_CHOICES = [
  { name: 'Enable', value: 'enable' },
  { name: 'Disable', value: 'disable' },
  { name: 'Status', value: 'status' }
];

const RESTART_ACTION_CHOICES = [
  { name: 'Schedule Restart', value: 'schedule' },
  { name: 'Cancel Scheduled Restart', value: 'cancel' },
  { name: 'Check Status', value: 'status' }
];

const ACTIVITY_TYPE_CHOICES = [
  { name: 'Playing', value: 'playing' },
  { name: 'Listening', value: 'listening' },
  { name: 'Watching', value: 'watching' },
  { name: 'Competing', value: 'competing' },
  { name: 'Streaming', value: 'streaming' },
  { name: 'Clear', value: 'clear' }
];

const OWNER_IDS = parseOwnerIds(process.env.BOT_OWNER_IDS);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Bot management commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('setstatus')
        .setDescription('Change the bot status (Online, DND, Idle, Invisible)')
        .addStringOption(option =>
          option
            .setName('state')
            .setDescription('Choose the new status')
            .setRequired(true)
            .addChoices(...STATUS_CHOICES)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('setpresence')
        .setDescription('Update the bot activity (Playing/Listening/Watching/Competing/Streaming)')
        .addStringOption(option =>
          option
            .setName('activity_type')
            .setDescription('Type of activity')
            .setRequired(true)
            .addChoices(...ACTIVITY_TYPE_CHOICES)
        )
        .addStringOption(option =>
          option
            .setName('message')
            .setDescription('Activity text (e.g., song name, game, etc.)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('url')
            .setDescription('URL for streaming (required if type = Streaming)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('logs')
        .setDescription('Enable, disable or view music log status')
        .addStringOption(option =>
          option
            .setName('action')
            .setDescription('Choose what to do with music start logs')
            .setRequired(true)
            .addChoices(...LOG_ACTION_CHOICES)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('restart')
        .setDescription('Schedule a bot restart when it is not in any voice channel (owners only)')
        .addStringOption(option =>
          option
            .setName('action')
            .setDescription('Choose what to do')
            .setRequired(true)
            .addChoices(...RESTART_ACTION_CHOICES)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('lock')
        .setDescription('Lock or unlock bot commands for non-admins')
        .addStringOption(option =>
          option
            .setName('mode')
            .setDescription('Enable or disable the lock')
            .setRequired(true)
            .addChoices(
              { name: 'On', value: 'on' },
              { name: 'Off', value: 'off' }
            )
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction, client) {
    const t = await getTranslator(client, interaction.guildId);
    const subcommand = interaction.options.getSubcommand();
    if (!isBotOwner(interaction.user.id)) {
      return interaction.reply({ content: t('commands.admin.errors.not_owner'), ephemeral: true });
    }
    if (subcommand === 'setstatus') {
      return handleSetStatus(interaction, client, t);
    }
    if (subcommand === 'setpresence') {
      return handleSetPresence(interaction, client, t);
    }
    if (subcommand === 'logs') {
      return handleLogs(interaction, client, t);
    }
    if (subcommand === 'restart') {
      return handleRestart(interaction, client, t);
    }
    if (subcommand === 'lock') {
      return handleLock(interaction, client, t);
    }
    return interaction.reply({ content: t('errors.unknown_command'), ephemeral: true });
  }
};

function parseOwnerIds(rawIds) {
  if (!rawIds) return new Set();
  return new Set(
    rawIds
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
  );
}

function isBotOwner(userId) {
  if (!OWNER_IDS.size) {
    return false;
  }
  return OWNER_IDS.has(String(userId));
}

async function handleSetStatus(interaction, client, t) {
  const desiredStatus = interaction.options.getString('state', true);
  const statusKey = sanitizeStatusKey(desiredStatus);
  const presenceManager = client.presenceStore;
  const existingConfig = (presenceManager && (await presenceManager.getConfig())) || {};
  const config = { ...existingConfig, status: statusKey };

  const serializedActivity = serializeActivity(client.user?.presence?.activities?.[0]);
  if (serializedActivity) {
    config.activity = serializedActivity;
  }

  try {
    if (presenceManager) {
      await presenceManager.saveConfig(config);
    }
  } catch (error) {
    client.emit?.('error', error);
    return interaction.reply({ content: t('commands.admin.errors.storage_unavailable'), ephemeral: true });
  }

  try {
    if (presenceManager) {
      await presenceManager.applyConfig(client, config);
    } else {
      const payload = buildPresencePayload(config);
      await client.user.setPresence(payload);
    }
  } catch (error) {
    client.emit?.('error', error);
    return interaction.reply({ content: t('commands.admin.errors.unexpected'), ephemeral: true });
  }

  const statusLabel = t(`commands.admin.status.labels.${statusKey}`);
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(t('commands.admin.setstatus.success_title'))
    .setDescription(t('commands.admin.setstatus.success_description', { status: statusLabel }))
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleSetPresence(interaction, client, t) {
  const activityType = interaction.options.getString('activity_type', true);
  const message = interaction.options.getString('message');
  const url = interaction.options.getString('url');

  // Validações
  if (activityType !== 'clear' && activityType !== 'streaming') {
    if (!message) {
      return interaction.reply({
        content: t('commands.admin.setpresence.errors.message_required', { default: '❌ Please provide a message for the activity.' }),
        ephemeral: true
      });
    }
  }

  if (activityType === 'streaming') {
    if (!message) {
      return interaction.reply({
        content: t('commands.admin.setpresence.errors.streaming_message_required', { default: '❌ Please provide a message for streaming.' }),
        ephemeral: true
      });
    }
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return interaction.reply({
        content: t('commands.admin.setpresence.errors.streaming_url', { default: '❌ For streaming, provide a valid URL (Twitch/YouTube).' }),
        ephemeral: true
      });
    }
  }

  const presenceManager = client.presenceStore;
  if (!presenceManager) {
    return interaction.reply({
      content: t('commands.admin.errors.storage_unavailable', { default: '❌ Presence storage is not available.' }),
      ephemeral: true
    });
  }

  // Mantém status salvo (ou padrão online)
  const existingConfig = (await presenceManager.getConfig()) || {};
  const savedStatus = existingConfig.status || 'online';

  const config = { status: savedStatus };

  if (activityType === 'clear') {
    config.activity = null;
  } else {
    config.activity = {
      type: activityType,
      message: message || '',
      url: activityType === 'streaming' ? url : null
    };
  }

  // Salva e aplica
  try {
    await presenceManager.saveConfig(config);
    await presenceManager.applyConfig(client, config);
  } catch (error) {
    client.emit?.('error', error);
    return interaction.reply({
      content: t('commands.admin.errors.unexpected', { default: '❌ An unexpected error occurred.' }),
      ephemeral: true
    });
  }

  // Resposta de sucesso
  let description;
  if (activityType === 'clear') {
    description = t('commands.admin.setpresence.success.cleared', { default: 'Activity cleared.' });
  } else {
    const activityLabel = t(`commands.admin.activity_types.${activityType}`, { default: activityType });
    description = t('commands.admin.setpresence.success.updated', {
      default: `Activity set: **${activityLabel}** — ${message || ''}`,
      activity_label: activityLabel,
      message: message || ''
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle(t('commands.admin.setpresence.success.title', { default: '✅ Presence updated' }))
    .setDescription(description)
    .setTimestamp();

  if (activityType === 'streaming' && url) {
    embed.addFields({
      name: t('commands.admin.setpresence.success.url_label', { default: 'URL' }),
      value: url,
      inline: false
    });
  }

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleLogs(interaction, client, t) {
  const action = interaction.options.getString('action', true);
  const logStore = client.logSettingsStore;

  if (!logStore) {
    return interaction.reply({ content: t('commands.admin.logs.errors.storage_unavailable'), ephemeral: true });
  }

  if (action === 'status') {
    let enabled = false;
    try {
      enabled = await logStore.isMusicLogsEnabled();
    } catch (error) {
      client.emit?.('error', error);
      return interaction.reply({ content: t('commands.admin.logs.errors.status_failed'), ephemeral: true });
    }

    const statusKey = enabled ? 'commands.admin.logs.status_enabled' : 'commands.admin.logs.status_disabled';
    const channelId = (process.env.LOG_CHANNEL_ID || '').trim();
    const channelLabel = channelId ? `<#${channelId}>` : t('commands.admin.logs.status_channel_unset');
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(t('commands.admin.logs.status_title'))
      .setDescription(t('commands.admin.logs.status_description', { status: t(statusKey) }))
      .addFields({ name: t('commands.admin.logs.status_channel_label'), value: channelLabel, inline: false })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (action !== 'enable' && action !== 'disable') {
    return interaction.reply({ content: t('errors.unknown_command'), ephemeral: true });
  }

  const shouldEnable = action === 'enable';
  try {
    await logStore.setMusicLogsEnabled(shouldEnable);
  } catch (error) {
    client.emit?.('error', error);
    return interaction.reply({ content: t('commands.admin.logs.errors.toggle_failed'), ephemeral: true });
  }

  const key = shouldEnable ? 'enable' : 'disable';
  const colors = { enable: 0x57f287, disable: 0xed4245 };
  const embed = new EmbedBuilder()
    .setColor(colors[key])
    .setTitle(t(`commands.admin.logs.${key}_title`))
    .setDescription(t(`commands.admin.logs.${key}_description`))
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleRestart(interaction, client, t) {
  const action = interaction.options.getString('action', true);

  if (!client._restartState) {
    client._restartState = { scheduled: false, interval: null };
  }

  if (action === 'status') {
    const activeConnections = countActiveVoiceConnections(client);
    const statusKey = client._restartState.scheduled
      ? 'commands.admin.restart.status.scheduled'
      : 'commands.admin.restart.status.not_scheduled';

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(t('commands.admin.restart.status.title'))
      .setDescription(t('commands.admin.restart.status.description', { status: t(statusKey) }))
      .addFields({
        name: t('commands.admin.restart.status.active_connections_label'),
        value: String(activeConnections),
        inline: true
      })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (action === 'cancel') {
    if (!client._restartState.scheduled) {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(t('commands.admin.restart.cancel.none_title'))
        .setDescription(t('commands.admin.restart.cancel.none_description'))
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    client._restartState.scheduled = false;
    if (client._restartState.interval) {
      clearInterval(client._restartState.interval);
      client._restartState.interval = null;
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(t('commands.admin.restart.cancel.success_title'))
      .setDescription(t('commands.admin.restart.cancel.success_description'))
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (action !== 'schedule') {
    return interaction.reply({ content: t('errors.unknown_command'), ephemeral: true });
  }

  if (client._restartState.scheduled) {
    const embed = new EmbedBuilder()
      .setColor(0xffaa00)
      .setTitle(t('commands.admin.restart.schedule.already_title'))
      .setDescription(t('commands.admin.restart.schedule.already_description'))
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  client._restartState.scheduled = true;
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(t('commands.admin.restart.schedule.success_title'))
    .setDescription(t('commands.admin.restart.schedule.success_description'))
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });

  if (client._restartState.interval) {
    clearInterval(client._restartState.interval);
    client._restartState.interval = null;
  }

  const tick = async () => {
    if (!client._restartState?.scheduled) return;

    const active = countActiveVoiceConnections(client);
    if (active > 0) return;

    // Safe to restart now.
    client._restartState.scheduled = false;
    if (client._restartState.interval) {
      clearInterval(client._restartState.interval);
      client._restartState.interval = null;
    }

    try {
      await destroyAllPlayers(client);
    } catch (error) {
      client.emit?.('error', error);
    }

    try {
      if (typeof client.softRestart === 'function') {
        await client.softRestart();
        return;
      }
    } catch (error) {
      client.emit?.('error', error);
    }

    // Fallback: hard-exit if soft restart isn't available.
    setTimeout(() => process.exit(0), 500);
  };

  // Poll every 10s, plus a quick initial check.
  client._restartState.interval = setInterval(() => tick().catch(() => {}), 10_000);
  setTimeout(() => tick().catch(() => {}), 1000);
}

function countActiveVoiceConnections(client) {
  try {
    // Primary: any guild where the bot is currently connected to voice.
    let connected = 0;
    for (const guild of client.guilds.cache.values()) {
      const botVoice = guild.members?.me?.voice;
      if (botVoice?.channelId) connected += 1;
    }
    if (connected > 0) return connected;
  } catch {
    // fall through
  }

  // Fallback: players with a voiceId
  try {
    let connected = 0;
    for (const player of client.kazagumo.players.values()) {
      if (player?.voiceId) connected += 1;
    }
    return connected;
  } catch {
    return 0;
  }
}

async function destroyAllPlayers(client) {
  if (!client?.kazagumo?.players) return;
  const players = Array.from(client.kazagumo.players.values());
  for (const player of players) {
    try {
      await player.destroy();
    } catch {
      // ignore
    }
  }
}

async function handleLock(interaction, client, t) {
  const mode = interaction.options.getString('mode', true);

  if (mode === 'off') {
    client._commandLock = { enabled: false };

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(t('commands.admin.lock.disabled_title'))
      .setDescription(t('commands.admin.lock.disabled_description'))
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // mode === 'on' → show modal for customization
  const modal = new ModalBuilder()
    .setCustomId('admin_lock_modal')
    .setTitle(t('commands.admin.lock.modal_title'));

  const titleInput = new TextInputBuilder()
    .setCustomId('lock_title')
    .setLabel(t('commands.admin.lock.modal_label_title'))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(t('commands.admin.lock.modal_placeholder_title'))
    .setRequired(true)
    .setMaxLength(256);

  const descInput = new TextInputBuilder()
    .setCustomId('lock_description')
    .setLabel(t('commands.admin.lock.modal_label_description'))
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(t('commands.admin.lock.modal_placeholder_description'))
    .setRequired(true)
    .setMaxLength(2000);

  const link1Input = new TextInputBuilder()
    .setCustomId('lock_link1')
    .setLabel(t('commands.admin.lock.modal_label_link', { n: '1' }))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Label | https://example.com')
    .setRequired(false)
    .setMaxLength(200);

  const link2Input = new TextInputBuilder()
    .setCustomId('lock_link2')
    .setLabel(t('commands.admin.lock.modal_label_link', { n: '2' }))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Label | https://example.com')
    .setRequired(false)
    .setMaxLength(200);

  const link3Input = new TextInputBuilder()
    .setCustomId('lock_link3')
    .setLabel(t('commands.admin.lock.modal_label_link', { n: '3' }))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Label | https://example.com')
    .setRequired(false)
    .setMaxLength(200);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput),
    new ActionRowBuilder().addComponents(link1Input),
    new ActionRowBuilder().addComponents(link2Input),
    new ActionRowBuilder().addComponents(link3Input)
  );

  await interaction.showModal(modal);
}
