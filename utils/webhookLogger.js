const { WebhookClient, EmbedBuilder } = require('discord.js');

let botWebhook = null;
let siteWebhook = null;

function getBotWebhook() {
  const url = (process.env.BOT_LOGS_WEBHOOK_URL || '').trim();
  if (!url) return null;
  if (!botWebhook) {
    botWebhook = new WebhookClient({ url });
  }
  return botWebhook;
}

function getSiteWebhook() {
  const url = (process.env.SITE_LOGS_WEBHOOK_URL || '').trim();
  if (!url) return null;
  if (!siteWebhook) {
    siteWebhook = new WebhookClient({ url });
  }
  return siteWebhook;
}

/**
 * Send a message to the bot logs webhook.
 * Accepts any options valid for WebhookClient.send() — content, embeds, components, files, flags, etc.
 */
async function sendBotLog(options) {
  const wh = getBotWebhook();
  if (!wh) return;
  try {
    await wh.send(options);
  } catch (err) {
    console.error('[BotLog Webhook] Failed to send:', err.message);
  }
}

/**
 * Send a message to the site logs webhook.
 * Accepts any options valid for WebhookClient.send().
 */
async function sendSiteLog(options) {
  const wh = getSiteWebhook();
  if (!wh) return;
  try {
    await wh.send(options);
  } catch (err) {
    console.error('[SiteLog Webhook] Failed to send:', err.message);
  }
}

/**
 * Log a site login event.
 * @param {{ id: string, username: string, avatar: string|null, globalName?: string }} user
 */
async function logSiteLogin(user) {
  const wh = getSiteWebhook();
  if (!wh) return;

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const displayName = user.globalName || user.username;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔐 Login no Site')
    .setThumbnail(avatarUrl)
    .addFields(
      { name: 'Usuário', value: `**${displayName}** (\`${user.username}\`)`, inline: true },
      { name: 'ID', value: `\`${user.id}\``, inline: true }
    )
    .setTimestamp();

  try {
    await wh.send({ embeds: [embed] });
  } catch (err) {
    console.error('[SiteLog Webhook] Failed to send login log:', err.message);
  }
}

/**
 * Log a "now playing via site" event.
 * @param {{ title: string, uri?: string }} track
 * @param {{ id: string, username: string }} user - JWT user who triggered the play
 * @param {string} guildName
 */
async function logSiteNowPlaying(track, user, guildName) {
  const wh = getSiteWebhook();
  if (!wh) return;

  const trackValue = track.uri ? `[${track.title}](${track.uri})` : track.title;

  const embed = new EmbedBuilder()
    .setColor(0xF53F5F)
    .setTitle('🎵 Tocando via Site')
    .addFields(
      { name: 'Track', value: trackValue },
      { name: 'Servidor', value: guildName || 'Desconhecido', inline: true },
      { name: 'Solicitado por', value: `**${user.username}** (\`${user.id}\`)`, inline: true }
    )
    .setTimestamp();

  try {
    await wh.send({ embeds: [embed] });
  } catch (err) {
    console.error('[SiteLog Webhook] Failed to send now-playing log:', err.message);
  }
}

module.exports = { sendBotLog, sendSiteLog, logSiteLogin, logSiteNowPlaying };
