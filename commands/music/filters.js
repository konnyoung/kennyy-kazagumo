const { SlashCommandBuilder } = require('discord.js');
const { getTranslator } = require('../../utils/localeHelpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('filters')
    .setDescription('Open the audio filter control panel'),
  async execute(interaction, client) {
    const t = await getTranslator(client, interaction.guildId);
    const player = client.kazagumo.players.get(interaction.guildId);

    if (!player) {
      return interaction.reply({ content: t('common.no_player'), ephemeral: true });
    }

    if (!player.queue?.current) {
      return interaction.reply({ content: t('commands.filter.no_track'), ephemeral: true });
    }

    const helpers = client.filterHelpers;
    if (!helpers) {
      return interaction.reply({ content: t('errors.command_failed'), ephemeral: true });
    }

    const state = helpers.getFilterState(player);
    const filterPayload = helpers.buildFilterEmbed(player, t);
    const components = helpers.buildFilterComponents(state, t);

    // Inject filter buttons into the V2 container
    filterPayload.components[0].addActionRowComponents(...components);

    const message = await interaction.reply({ ...filterPayload, fetchReply: true });

    state.messageId = message.id;
    state.channelId = message.channelId;
    helpers.storeFilterState(player, state);
  }
};
