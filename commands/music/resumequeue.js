const { SlashCommandBuilder } = require('discord.js');
const { getTranslator } = require('../../utils/localeHelpers');
const { v2Reply } = require('../../utils/embedV2');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resumequeue')
    .setDescription('Resume the last saved queue after a disconnection'),
  async execute(interaction, client) {
    const t = await getTranslator(client, interaction.guildId);
    
    await interaction.deferReply();
    
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.editReply({ content: t('common.voice_required') });
    }

    // Check if cache exists
    if (!client.queueCache?.hasCache(interaction.guildId)) {
      const noCache = v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.resumequeue.no_cache_title')}`, description: t('commands.resumequeue.no_cache_description') });
      return interaction.editReply(noCache);
    }

    const cachedTracks = client.queueCache.getQueue(interaction.guildId);
    if (!cachedTracks?.length) {
      const noCache2 = v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.resumequeue.no_cache_title')}`, description: t('commands.resumequeue.no_cache_description') });
      return interaction.editReply(noCache2);
    }

    // Check bot permissions
    const botMember = interaction.guild.members.me;
    if (!voiceChannel.permissionsFor(botMember).has(['Connect', 'Speak', 'ViewChannel'])) {
      const permPayload = v2Reply({ color: 0xFF0000, title: `${process.env.EMOJI_DANCE || '<a:dance_teto:1451252227133018374>'} ${t('common.no_voice_permissions_title') || 'Missing Permissions'}`, description: t('common.no_voice_permissions') });
      return interaction.editReply(permPayload);
    }

    let player = client.kazagumo.players.get(interaction.guildId);
    
    // Check for ghost player - use lavalinkMonitor health check
    if (player) {
      const playerNodeName = player.shoukaku?.node?.name;
      const isNodeOk = playerNodeName 
        ? client.lavalinkMonitor?.isNodeHealthy?.(playerNodeName) 
        : false;
      
      if (!isNodeOk) {
        try {
          await player.destroy();
          player = null;
        } catch (error) {
          client.kazagumo.players.delete(interaction.guildId);
          player = null;
        }
      }
    }

    const hadActivePlayer = Boolean(player && (player.queue.length || player.playing || player.paused));
    const preferredNodeName = client.lavalinkMonitor?.getLeastUsedNodeName?.();

    // Check if any node is available - use lavalinkMonitor health check
    const hasAvailableNode = client.lavalinkMonitor?.hasHealthyNode?.() ?? 
      Array.from(client.kazagumo.shoukaku.nodes.values()).some(n => n.state === 1);
    if (!hasAvailableNode) {
      const noNodePayload = v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.lavalink_error_title')}`, description: t('errors.lavalink_error_description') });
      return interaction.editReply(noNodePayload);
    }

    // Create player if doesn't exist
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

    // Resolve and add tracks using search (ensures proper Kazagumo track objects)
    let addedCount = 0;
    let firstTrack = null;
    let failedCount = 0;
    
    // Show loading embed
    const loadingPayload = v2Reply({ color: 0xF53F5F, description: `# ${process.env.EMOJI_UNADANCE || '<a:unadance:1450689460307230760>'} ${t('commands.resumequeue.loading') || 'Restoring queue...'}` });
    await interaction.editReply(loadingPayload);
    
    for (const cached of cachedTracks) {
      try {
        // Use URI or title+author as search query
        const searchQuery = cached.uri || cached.identifier || `${cached.title} ${cached.author}`;
        if (!searchQuery) {
          failedCount++;
          continue;
        }
        
        // Add small delay between search requests to avoid rate limiting
        if (addedCount > 0) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        
        const result = await client.kazagumo.search(searchQuery, { 
          requester: interaction.user 
        });
        
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
        // Skip failed tracks silently
        console.error(`[ResumeQueue] Failed to resolve track: ${cached.title}`, error.message);
        failedCount++;
        
        // If it's a Lavalink error, the node might be down - stop trying
        if (error?.message?.includes('Lavalink') || error?.name === 'RestError') {
          break;
        }
      }
    }

    if (addedCount === 0) {
      const failedPayload = v2Reply({ color: 0xff6b6b, title: `${process.env.EMOJI_PANIC || '<a:panic:1451081526522417252>'} ${t('commands.resumequeue.failed_title')}`, description: t('commands.resumequeue.failed_description') });
      
      if (!hadActivePlayer && player) {
        try {
          await player.destroy();
        } catch {
          client.kazagumo.players.delete(interaction.guildId);
        }
      }
      return interaction.editReply(failedPayload);
    }

    // Clear cache after successful resume
    client.queueCache.clearQueue(interaction.guildId);

    // Start playing if not already
    if (!player.playing && !player.paused) {
      await player.play();
    }

    // Build success embed
    const cacheAge = client.queueCache.getCacheAge(interaction.guildId);
    const successPayload = v2Reply({
      color: 0xF53F5F,
      title: `${process.env.EMOJI_DANCE || '<a:dance_teto:1451252227133018374>'} ${t('commands.resumequeue.success_title')}`,
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
};
