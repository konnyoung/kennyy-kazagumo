const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getTranslator } = require('../../utils/localeHelpers');

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
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.editReply({ content: t('common.voice_required') });
    }

    // Verificar permissões do bot no canal de voz
    const botMember = interaction.guild.members.me;
    if (!voiceChannel.permissionsFor(botMember).has(['Connect', 'Speak', 'ViewChannel'])) {
      const permEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle(`${process.env.EMOJI_DANCE || '<a:dance_teto:1451252227133018374>'} ${t('common.no_voice_permissions_title') || 'Missing Permissions'}`)
        .setDescription(t('common.no_voice_permissions'));
      return interaction.editReply({ embeds: [permEmbed] });
    }

    // Verificar permissões do bot no canal de texto
    if (!interaction.channel.permissionsFor(botMember).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      const permEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle(`${process.env.EMOJI_DANCE || '<a:dance_teto:1451252227133018374>'} ${t('common.no_text_permissions_title') || 'Missing Permissions'}`)
        .setDescription(t('common.no_text_permissions'));
      return interaction.editReply({ embeds: [permEmbed] });
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
    
    const hadActivePlayer = Boolean(player && (player.queue.length || player.playing || player.paused));
    const preferredNodeName = client.lavalinkMonitor?.getLeastUsedNodeName?.();

    // Check if any healthy node is available before proceeding
    const hasAvailableNode = client.lavalinkMonitor?.hasHealthyNode?.() ?? 
      Array.from(client.kazagumo.shoukaku.nodes.values()).some(n => n.state === 1);
    if (!hasAvailableNode) {
      const noNodeEmbed = new EmbedBuilder()
        .setColor(0xff6b6b)
        .setTitle(`${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.lavalink_error_title')}`)
        .setDescription(t('errors.lavalink_error_description'));
      return interaction.editReply({ embeds: [noNodeEmbed] });
    }

    if (player && player.voiceId && voiceChannel.id !== player.voiceId) {
      return interaction.editReply({ content: t('commands.play.already_other_channel') });
    }

    if (!player) {
      const playerOptions = {
        guildId: interaction.guildId,
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

    // Show a Python-like "Searching" feedback while we resolve tracks.
    const searchingEmbed = new EmbedBuilder()
      .setColor(0x5284ff)
      .setDescription(`# ${process.env.EMOJI_UNADANCE || '<a:unadance:1450689460307230760>'} ${t('commands.play.searching')}`);
    await interaction.editReply({ embeds: [searchingEmbed] });

    try {
      const requester = interaction.user;
      const isUrl = /^https?:\/\//.test(query);
      const searchOptions = { requester };
      if (!isUrl) {
        searchOptions.source = 'spsearch:';
      }
      const result = await client.kazagumo.search(query, searchOptions);

      if (!result.tracks?.length) {
        const noResultsEmbed = new EmbedBuilder()
          .setColor(0x00BFFF)
          .setTitle(`${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.play.no_results_title')}`)
          .setDescription(t('commands.play.no_results_description'));
        await interaction.editReply({ embeds: [noResultsEmbed] });
        if (player && !hadActivePlayer) {
          await player.destroy();
        }
        return;
      }

      let addedTracks = [];
      if (result.type === 'PLAYLIST') {
        for (const track of result.tracks) {
          player.queue.add(track);
        }
        addedTracks = result.tracks;
      } else {
        const track = result.tracks[0];
        if (!track) {
          const loadFailedEmbed = new EmbedBuilder()
            .setColor(0x00BFFF)
            .setTitle(`${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.play.load_failed_title')}`)
            .setDescription(t('commands.play.load_failed_description'));
          await interaction.editReply({ embeds: [loadFailedEmbed] });
          if (player && !hadActivePlayer) {
            await player.destroy();
          }
          return;
        }
        player.queue.add(track);
        addedTracks = [track];
      }

      if (!player.playing && !player.paused) {
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

      // Avoid redundant messages: the now-playing embed will be posted automatically.
      await interaction.deleteReply().catch(() => {});
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
        
        const lavalinkEmbed = new EmbedBuilder()
          .setColor(0xff6b6b)
          .setTitle(`${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.lavalink_error_title')}`)
          .setDescription(t('errors.lavalink_error_description'));
        return interaction.editReply({ embeds: [lavalinkEmbed] });
      }
      
      client.emit('error', error);
      return interaction.editReply({ content: t('commands.play.search_error') });
    }
  }
};

function buildQueuedEmbed({ tracks, playlistName, requester, queueLength, t }) {
  const embed = new EmbedBuilder().setTimestamp();
  const firstTrack = tracks[0];
  const isPlaylist = Boolean(playlistName && tracks.length > 1);
  const color = trackSourceColor(firstTrack);
  if (color) embed.setColor(color);
  const artwork = getTrackArtwork(firstTrack);
  if (artwork) embed.setThumbnail(artwork);

  if (isPlaylist) {
    embed
      .setTitle(t('commands.play.playlist_title'))
      .setDescription(
        t('commands.play.playlist_description', {
          name: playlistName,
          count: tracks.length
        })
      )
      .addFields(
        {
          name: t('queue.field_first_track'),
          value: formatTrackTitle(firstTrack) ?? t('common.unknown'),
          inline: true
        },
        {
          name: t('commands.play.requested_by'),
          value: formatRequester(requester, t),
          inline: true
        }
      );
  } else {
    const singleTrack = firstTrack ?? {};
    embed
      .setTitle(t('commands.play.track_title'))
      .setDescription(
        t('commands.play.track_description', {
          title: formatTrackTitle(singleTrack) ?? t('commands.play.track_title')
        })
      )
      .addFields(
        {
          name: t('commands.play.artist'),
          value: singleTrack.author ?? t('common.unknown'),
          inline: true
        },
        {
          name: t('commands.play.duration'),
          value: formatDuration(singleTrack.duration ?? singleTrack.length),
          inline: true
        },
        {
          name: t('commands.play.requested_by'),
          value: formatRequester(requester, t),
          inline: true
        }
      );
  }

  embed.setFooter({ text: t('commands.play.footer', { count: queueLength }) });
  return { embeds: [embed] };
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
