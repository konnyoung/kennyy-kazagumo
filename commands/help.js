const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, MessageFlags } = require('discord.js');
const { getTranslator } = require('../utils/localeHelpers');
const fs = require('node:fs');
const path = require('node:path');

// Count commands dynamically
function countCommandsInCategory(category) {
  const categoryPath = path.join(__dirname, category);
  if (!fs.existsSync(categoryPath)) return 0;
  const files = fs.readdirSync(categoryPath).filter(file => file.endsWith('.js'));
  return files.length;
}

// Count all commands
function countTotalCommands() {
  let total = 0;
  // Root commands
  const rootFiles = fs.readdirSync(__dirname).filter(file => file.endsWith('.js') && file !== 'help.js');
  total += rootFiles.length;
  
  // Music commands
  total += countCommandsInCategory('music');
  
  // Config commands
  total += countCommandsInCategory('config');
  
  return total;
}

// Count supported languages
function countSupportedLanguages() {
  const localesPath = path.join(__dirname, '..', 'locales');
  if (!fs.existsSync(localesPath)) return 0;
  return fs.readdirSync(localesPath).filter(file => file.endsWith('.json')).length;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands and how to use them'),

  async execute(interaction, client) {
    const t = await getTranslator(client, interaction.guildId);
    
    // Get dynamic counts
    const musicCount = countCommandsInCategory('music');
    const totalCommands = countTotalCommands();
    const languageCount = countSupportedLanguages();
    
    const mainContainer = buildHelpContainer(t, client, 'home', { musicCount, totalCommands, languageCount });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('help_category')
      .setPlaceholder(t('commands.help.dropdown.placeholder'))
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(t('commands.help.categories.music'))
          .setDescription(t('commands.help.categories.music_short', { count: musicCount }))
          .setValue('music')
          .setEmoji('🎵'),
        new StringSelectMenuOptionBuilder()
          .setLabel(t('commands.help.categories.config'))
          .setDescription(t('commands.help.categories.config_short'))
          .setValue('config')
          .setEmoji('⚙️'),
        new StringSelectMenuOptionBuilder()
          .setLabel(t('commands.help.categories.utilities'))
          .setDescription(t('commands.help.categories.utilities_short'))
          .setValue('utilities')
          .setEmoji('🛠️'),
        new StringSelectMenuOptionBuilder()
          .setLabel(t('commands.help.categories.admin'))
          .setDescription(t('commands.help.categories.admin_short'))
          .setValue('admin')
          .setEmoji('🔐'),
        new StringSelectMenuOptionBuilder()
          .setLabel(t('commands.help.categories.home'))
          .setDescription(t('commands.help.categories.home_short'))
          .setValue('home')
          .setEmoji('🏠')
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);
    mainContainer.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    mainContainer.addActionRowComponents(row);

    const response = await interaction.reply({
      components: [mainContainer],
      flags: MessageFlags.IsComponentsV2,
      fetchReply: true
    });

    const collector = response.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 300000
    });

    collector.on('collect', async i => {
      const selectedCategory = i.values[0];
      const container = buildHelpContainer(t, client, selectedCategory, { musicCount, totalCommands, languageCount });
      const menuRow = new ActionRowBuilder().addComponents(selectMenu);
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addActionRowComponents(menuRow);
      await i.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    });

    collector.on('end', async () => {
      try {
        const disabledMenu = StringSelectMenuBuilder.from(selectMenu).setDisabled(true);
        const disabledRow = new ActionRowBuilder().addComponents(disabledMenu);
        const disabledContainer = buildHelpContainer(t, client, 'home', { musicCount, totalCommands, languageCount });
        disabledContainer.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
        disabledContainer.addActionRowComponents(disabledRow);
        await response.edit({ components: [disabledContainer], flags: MessageFlags.IsComponentsV2 });
      } catch (error) {
        // Message might be deleted
      }
    });
  }
};

function buildHelpContainer(t, client, category, { musicCount, totalCommands, languageCount } = {}) {
  const container = new ContainerBuilder();

  switch (category) {
    case 'music': {
      container.setAccentColor(0xff0066);
      const cmds = [
        `</play:0> — ${t('commands.help.music.play')}`,
        `</pause:0> — ${t('commands.help.music.pause')}`,
        `</resume:0> — ${t('commands.help.music.resume')}`,
        `</skip:0> — ${t('commands.help.music.skip')}`,
        `</stop:0> — ${t('commands.help.music.stop')}`,
        `</queue:0> — ${t('commands.help.music.queue')}`,
        `</shuffle:0> — ${t('commands.help.music.shuffle')}`,
        `</skipto:0> — ${t('commands.help.music.skipto')}`,
        `</seek:0> — ${t('commands.help.music.seek')}`,
        `</lyrics:0> — ${t('commands.help.music.lyrics')}`,
        `</filters:0> — ${t('commands.help.music.filters')}`
      ].join('\n');
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🎵 ${t('commands.help.categories.music')}`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t('commands.help.music.description', { count: musicCount })));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cmds));
      break;
    }
    case 'config': {
      container.setAccentColor(0xF53F5F);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ⚙️ ${t('commands.help.categories.config')}`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t('commands.help.config.description')));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`</language:0> — ${t('commands.help.config.language', { count: languageCount })}`));
      break;
    }
    case 'utilities': {
      container.setAccentColor(0xF53F5F);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🛠️ ${t('commands.help.categories.utilities')}`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t('commands.help.utilities.description')));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`</ping:0> — ${t('commands.help.utilities.ping')}`));
      break;
    }
    case 'admin': {
      container.setAccentColor(0xff0000);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🔐 ${t('commands.help.categories.admin')}`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t('commands.help.admin.description')));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`</admin:0> — ${t('commands.help.admin.admin')}`));
      break;
    }
    default: { // home
      container.setAccentColor(0xF53F5F);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${t('commands.help.main.title')}`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t('commands.help.main.description')));
      const categories = [
        `🎵 **${t('commands.help.categories.music')}** — ${t('commands.help.categories.music_description')}`,
        `⚙️ **${t('commands.help.categories.config')}** — ${t('commands.help.categories.config_description')}`,
        `🛠️ **${t('commands.help.categories.utilities')}** — ${t('commands.help.categories.utilities_description')}`
      ].join('\n');
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(categories));
      break;
    }
  }

  return container;
}
