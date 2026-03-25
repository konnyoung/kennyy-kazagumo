const { SlashCommandBuilder } = require('discord.js');
const { getTranslator } = require('../../utils/localeHelpers');
const { v2Reply } = require('../../utils/embedV2');

const TRACK_SOURCE_COLORS = Object.freeze({
  ytmusic: 0xff0050,
  youtube: 0xff0000,
  deezer: 0xff9900,
  spotify: 0x1db954,
  applemusic: 0xfa2d48,
  soundcloud: 0xff5500,
  twitch: 0x9146ff
});

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('Link or search term')
        .setRequired(true)
    ),
  async execute(interaction, client) {
    // Defer IMMEDIATELY to prevent interaction timeout
    await interaction.deferReply();
    
    const t = await getTranslator(client, interaction.guildId);
    const query = interaction.options.getString('query', true);
    if (isLiveLikeUrl(query)) {
      const noResultsPayload = v2Reply({ color: 0x00BFFF, title: `${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.play.no_results_title')}`, description: t('commands.play.no_results_description') });
      return interaction.editReply(noResultsPayload);
    }
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.editReply({ content: t('common.voice_required') });
    }

    // Verificar permissões do bot no canal de voz
    const botMember = interaction.guild.members.me;
    if (!voiceChannel.permissionsFor(botMember).has(['Connect', 'Speak', 'ViewChannel'])) {
      const permPayload = v2Reply({ color: 0xFF0000, title: `${process.env.EMOJI_DANCE || '<a:dance_teto:1451252227133018374>'} ${t('common.no_voice_permissions_title') || 'Missing Permissions'}`, description: t('common.no_voice_permissions') });
      return interaction.editReply(permPayload);
    }

    // Verificar permissões do bot no canal de texto
    if (!interaction.channel.permissionsFor(botMember).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      const permPayload = v2Reply({ color: 0xFF0000, title: `${process.env.EMOJI_DANCE || '<a:dance_teto:1451252227133018374>'} ${t('common.no_text_permissions_title') || 'Missing Permissions'}`, description: t('common.no_text_permissions') });
      return interaction.editReply(permPayload);
    }

    let player = client.kazagumo.players.get(interaction.guildId);
    
    // Check if player exists but node is disconnected or unhealthy (ghost player)
    if (player) {
      const playerNodeName = player.shoukaku?.node?.name;
      const nodeState = player.shoukaku?.node?.state;
      const isNodeHealthy = client.lavalinkMonitor?.isNodeHealthy?.(playerNodeName) ?? (nodeState === 1);
      
      if (!isNodeHealthy) {
        try {
          await player.destroy();
          player = null;
        } catch (error) {
          // Force remove ghost player
          client.kazagumo.players.delete(interaction.guildId);
          player = null;
        }
      }
    }
    
    // Clear any leftover lonely-leave snapshot for this guild
    if (client.afkSnapshots?.has(interaction.guildId)) {
      client.afkSnapshots.delete(interaction.guildId);
    }

    const hadActivePlayer = Boolean(player && (player.queue.length || player.playing || player.paused));
    const preferredNodeName = client.lavalinkMonitor?.getLeastUsedNodeName?.();

    // Quick check: is any node already connected?
    const anyNodeConnected = () =>
      Array.from(client.kazagumo.shoukaku.nodes.values()).some(n => n.state === 1);
    let hasAvailableNode = anyNodeConnected();
    if (!hasAvailableNode) {
      hasAvailableNode = await attemptLavalinkRecovery(client);
    }
    if (!hasAvailableNode) {
      const noNodePayload = v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.lavalink_error_title')}`, description: t('errors.lavalink_error_description') });
      return interaction.editReply(noNodePayload);
    }

    if (player && player.voiceId && voiceChannel.id !== player.voiceId) {
      return interaction.editReply({ content: t('commands.play.already_other_channel') });
    }

    if (!player) {
      try {
        player = await createPlayerWithRecovery(client, {
          guildId: interaction.guildId,
          voiceId: voiceChannel.id,
          textId: interaction.channelId,
          deaf: true,
          volume: 100
        });
      } catch (error) {
        const lavalinkPayload = v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.lavalink_error_title')}`, description: t('errors.lavalink_error_description') });
        return interaction.editReply(lavalinkPayload);
      }
    } else {
      if (player.voiceId !== voiceChannel.id) {
        player.setVoiceChannel(voiceChannel.id);
      }
      player.setTextChannel(interaction.channelId);
    }

    // Show a "Searching" feedback while we resolve tracks.
    const emoji = process.env.EMOJI_UNADANCE || '<a:unadance:1450689460307230760>';
    const searchingPayload = v2Reply({ color: 0xF53F5F, description: `# ${emoji} ${t('commands.play.searching')}` });
    await interaction.editReply(searchingPayload);

    try {
      const requester = interaction.user;
      const isUrl = /^https?:\/\//.test(query);
      const searchOptions = { requester };
      if (!isUrl) {
        searchOptions.source = 'spsearch:';
      }
      const result = await client.kazagumo.search(query, searchOptions);
      const availableTracks = (result.tracks || []).filter((track) => !isStreamTrack(track));

      if (!availableTracks.length) {
        const noResultsPayload = v2Reply({ color: 0x00BFFF, title: `${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.play.no_results_title')}`, description: t('commands.play.no_results_description') });
        await interaction.editReply(noResultsPayload);
        if (player && !hadActivePlayer) {
          await player.destroy();
        }
        return;
      }

      let addedTracks = [];
      if (result.type === 'PLAYLIST') {
        for (const track of availableTracks) {
          player.queue.add(track);
        }
        addedTracks = availableTracks;
      } else {
        const track = availableTracks[0];
        if (!track) {
          const loadFailedPayload = v2Reply({ color: 0x00BFFF, title: `${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.play.load_failed_title')}`, description: t('commands.play.load_failed_description') });
          await interaction.editReply(loadFailedPayload);
          if (player && !hadActivePlayer) {
            await player.destroy();
          }
          return;
        }
        player.queue.add(track);
        addedTracks = [track];
      }

      if (!player.playing && !player.paused) {
        // Store translator + interaction so playerStart can reuse them
        player.data.set('cachedTranslator', t);
        player.data.set('searchingInteraction', interaction);
        await player.play();
      }

      if (hadActivePlayer) {
        const payload = buildQueuedEmbed({
          tracks: addedTracks,
          playlistName: result.playlistName,
          requester,
          queueLength: player.queue.length,
          t
        });
        return interaction.editReply(payload);
      }

      // Don't delete here — playerStart will clean up after sending the Now Playing embed.
      return;
    } catch (error) {
      // Check if it's a Lavalink connection error
      const isLavalinkError = error?.message?.includes('Lavalink') || 
                              error?.message?.includes('RestError') ||
                              error?.name === 'RestError';
      
      if (isLavalinkError) {
        // Destroy player if it exists to avoid ghost state
        if (player && !hadActivePlayer) {
          try {
            await player.destroy();
          } catch {
            client.kazagumo.players.delete(interaction.guildId);
          }
        }
        
        const lavalinkPayload = v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.lavalink_error_title')}`, description: t('errors.lavalink_error_description') });
        return interaction.editReply(lavalinkPayload);
      }
      
      client.emit('error', error);
      return interaction.editReply({ content: t('commands.play.search_error') });
    }
  }
};

async function createPlayerWithRecovery(client, baseOptions) {
  const preferredNodeName = client.lavalinkMonitor?.getLeastUsedNodeName?.();
  const playerOptions = { ...baseOptions };
  if (preferredNodeName) {
    playerOptions.nodeName = preferredNodeName;
  }

  try {
    return await client.kazagumo.createPlayer(playerOptions);
  } catch (firstError) {
    // Attempt recovery and retry without pinned nodeName
    const recovered = await attemptLavalinkRecovery(client);
    if (!recovered) throw firstError;

    const fallbackOptions = { ...baseOptions };
    return await client.kazagumo.createPlayer(fallbackOptions);
  }
}

async function attemptLavalinkRecovery(client, maxWaitMs = 6000) {
  const shoukaku = client?.kazagumo?.shoukaku;
  if (!shoukaku) return false;

  const CONNECTED = 1;
  const CONNECTING = 0;
  const isConnected = () =>
    Array.from(shoukaku.nodes.values()).some(n => n.state === CONNECTED);

  // Fast path: already connected
  if (isConnected()) return true;

  // Re-add nodes that Shoukaku removed after exhausting reconnect tries
  const nodeConfigs = client._lavalinkNodeConfigs;
  if (nodeConfigs) {
    for (const cfg of nodeConfigs) {
      if (!shoukaku.nodes.has(cfg.name)) {
        try {
          shoukaku.addNode(cfg);
        } catch {}
      }
    }
  }

  // Trigger connect on nodes stuck in DISCONNECTED (3) or DISCONNECTING (2)
  for (const node of shoukaku.nodes.values()) {
    if (node.state === CONNECTED || node.state === CONNECTING) continue;
    try {
      node.connect().catch(() => {});
    } catch {}
  }

  // Poll until a node becomes CONNECTED or timeout
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (isConnected()) return true;
    await wait(300);
  }

  return false;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLiveLikeUrl(query) {
  if (!/^https?:\/\//i.test(query || '')) return false;

  try {
    const url = new URL(query);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();

    if (host.includes('twitch.tv') || host.includes('kick.com') || host.includes('trovo.live')) {
      return true;
    }

    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      if (path.startsWith('/live') || path.includes('/live/')) return true;
      if (url.searchParams.get('live') === '1') return true;
    }
  } catch {
    return false;
  }

  return false;
}

function isStreamTrack(track) {
  return Boolean(track?.isStream ?? track?.info?.isStream ?? track?.raw?.info?.isStream);
}

function buildQueuedEmbed({ tracks, playlistName, requester, queueLength, t }) {
  const firstTrack = tracks[0];
  const isPlaylist = Boolean(playlistName && tracks.length > 1);
  const color = 0xF53F5F;

  let title, description, fields;

  if (isPlaylist) {
    title = t('commands.play.playlist_title');
    description = t('commands.play.playlist_description', { name: playlistName, count: tracks.length });
    fields = [
      { name: t('queue.field_first_track'), value: formatTrackTitle(firstTrack) ?? t('common.unknown'), inline: true },
      { name: t('commands.play.requested_by'), value: formatRequester(requester, t), inline: true }
    ];
  } else {
    const singleTrack = firstTrack ?? {};
    title = t('commands.play.track_title');
    description = t('commands.play.track_description', { title: formatTrackTitle(singleTrack) ?? t('commands.play.track_title') });
    fields = [
      { name: t('commands.play.artist'), value: singleTrack.author ?? t('common.unknown'), inline: true },
      { name: t('commands.play.duration'), value: formatDuration(singleTrack.duration ?? singleTrack.length), inline: true },
      { name: t('commands.play.requested_by'), value: formatRequester(requester, t), inline: true }
    ];
  }

  return v2Reply({ color, title, description, fields, footer: t('commands.play.footer', { count: queueLength }), timestamp: true });
}

function formatTrackTitle(track = {}) {
  if (!track) return null;
  const name = track.title ?? track.info?.title;
  if (!name) return null;
  const url = track.uri ?? track.url ?? track.info?.uri;
  return url ? `[${name}](${url})` : `**${name}**`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteBlock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${minuteBlock}` : minuteBlock;
}

function formatRequester(user, t) {
  if (!user) return t('common.unknown');
  return user.toString?.() ?? (user.id ? `<@${user.id}>` : t('common.unknown'));
}

function getTrackArtwork(track) {
  if (!track) return null;
  return track.thumbnail ?? track.artworkUrl ?? track.info?.artworkUrl ?? null;
}

function trackSourceColor(track) {
  const key = detectTrackSource(track);
  return (key && TRACK_SOURCE_COLORS[key]) || 0x5865f2;
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
