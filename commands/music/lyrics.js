const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getTranslator } = require('../../utils/localeHelpers');
const { fetchLyrics, findLineIndex, renderTimedSnippet, getApproxPositionMs } = require('../../utils/lyricsManager');
const { v2Reply } = require('../../utils/embedV2');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show lyrics for the current track'),
  async execute(interaction, client) {
    const t = await getTranslator(client, interaction.guildId);
    const player = client.kazagumo.players.get(interaction.guildId);

    if (!player) {
      return interaction.reply({ content: t('common.no_player'), ephemeral: true });
    }

    const track = player.queue.current;
    if (!track) {
      return interaction.reply({ content: t('lyrics.no_track'), ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: false });

    const searchingPayload = v2Reply({ color: 0xF53F5F, title: t('lyrics.searching_title'), description: t('lyrics.searching_description', { song: track.title }), footer: t('lyrics.searching_footer') });

    const message = await interaction.editReply(searchingPayload);

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
    const finalPayload = createLyricsPayload(track, lyricsData, description, t);

    const stopRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lyrics_stop')
        .setEmoji('🛑')
        .setLabel(t('lyrics.stop_button') ?? 'Stop')
        .setStyle(ButtonStyle.Danger)
    );
    finalPayload.components[0].addActionRowComponents(stopRow);

    await interaction.editReply(finalPayload);

    if (timedLines.length > 0) {
      startLyricsSync(player, message, track, lyricsData, t);
    }
  }
};

function createLyricsPayload(track, lyricsData, description, t) {
  if (description.length > 4000) {
    description = description.substring(0, 3997) + '...';
  }

  const artistLine = lyricsData.artist || track.author;
  const title = t('lyrics.embed_title', { title: lyricsData.title || track.title });
  const footer = t('lyrics.embed_footer', { track: track.title, source: lyricsData.source || '?' });
  const body = artistLine ? `-# ${artistLine}\n\n${description}` : description;

  return v2Reply({ color: 0xF53F5F, title, description: body, footer });
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
      console.log(`[Lyrics] Sync error: ${error.message}`);
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        clearInterval(interval);
        player.data.delete('lyricsInterval');
      }
    }
  }, 1000);

  player.data.set('lyricsInterval', interval);
}
