const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags
} = require('discord.js');

/**
 * Build a Components V2 container that replaces a classic embed.
 * @param {object} opts
 * @param {number}  opts.color       - Accent color (hex integer)
 * @param {string}  [opts.title]     - Rendered as markdown heading
 * @param {string}  [opts.description] - Body text
 * @param {Array<{name:string,value:string,inline?:boolean}>} [opts.fields]
 * @param {string}  [opts.footer]    - Small text at bottom (-# markdown)
 * @param {boolean} [opts.timestamp] - Append relative timestamp to footer
 * @param {import('discord.js').ActionRowBuilder[]} [opts.components] - Action rows to add
 * @returns {ContainerBuilder}
 */
function buildV2Container(opts = {}) {
  const container = new ContainerBuilder();
  if (opts.color != null) container.setAccentColor(opts.color);

  if (opts.title) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${opts.title}`)
    );
  }

  if (opts.description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(opts.description)
    );
  }

  if (opts.fields?.length) {
    const blocks = [];
    let inlineGroup = [];

    const flushInline = () => {
      if (inlineGroup.length) {
        blocks.push(inlineGroup.map(f => `**${f.name}** ${f.value}`).join(' • '));
        inlineGroup = [];
      }
    };

    for (const f of opts.fields) {
      if (f.inline) {
        inlineGroup.push(f);
      } else {
        flushInline();
        blocks.push(`**${f.name}**\n${f.value}`);
      }
    }
    flushInline();

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(blocks.join('\n\n'))
    );
  }

  if (opts.footer || opts.timestamp) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    let footerText = opts.footer || '';
    if (opts.timestamp) {
      const ts = `<t:${Math.floor(Date.now() / 1000)}:R>`;
      footerText = footerText ? `${footerText} • ${ts}` : ts;
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${footerText}`)
    );
  }

  if (opts.components?.length) {
    for (const row of opts.components) {
      container.addActionRowComponents(row);
    }
  }

  return container;
}

/**
 * Wrap a container into a V2 message payload.
 * @param {ContainerBuilder} container
 * @param {object} [extra] - Additional properties (files, etc.)
 * @returns {object}
 */
function v2Payload(container, extra = {}) {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    ...extra
  };
}

/**
 * Quick shorthand: build container + return payload.
 */
function v2Reply(opts = {}, extra = {}) {
  const container = buildV2Container(opts);
  return v2Payload(container, extra);
}

module.exports = { buildV2Container, v2Payload, v2Reply };
