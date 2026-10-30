'use strict';

const GOLD = 0xd4af37;
const installed = Symbol.for('dealdesk.discordTheme');
// Only presentation headings are normalized. Values, links, game boards,
// status emojis, components, and mention/visibility settings are untouched.
function heading(value) {
    if (typeof value !== 'string') return value;
    const cleaned = value
        .replace(/^[\s]*(?:[🌐🛡️🏘️💸🔔💼🎰🛠️📦👤🔄⚙️🤖📊💰🏆📋🎮🎲📈🪙]+[\s]*)+/u, '')
        .replace(/^─+\s*|\s*─+$/g, '').trim();
    return cleaned || value;
}

function styleEmbed(data) {
    const result = { ...data };
    // Keep explicit error/warning/success colors; ordinary embeds use gold.
    const semanticColors = new Set([0xed4245, 0xff0000, 0xe74c3c, 0x57f287, 0x2ecc71, 0x00ff00, 0xe67e22]);
    if (!semanticColors.has(result.color)) result.color = GOLD;
    if (result.title) result.title = heading(result.title);
    if (result.fields) result.fields = result.fields.map(field => ({ ...field, name: heading(field.name) }));
    return result;
}

function install({ EmbedBuilder }) {
    // Central serialization adapter covers existing commands and scheduled DMs
    // without modifying their business logic or mutating reusable builders.
    if (EmbedBuilder.prototype[installed]) return;
    const original = EmbedBuilder.prototype.toJSON;
    Object.defineProperty(EmbedBuilder.prototype, installed, { value: true });
    EmbedBuilder.prototype.toJSON = function (...args) {
        return styleEmbed(original.apply(this, args));
    };
}

module.exports = { GOLD, heading, styleEmbed, install };
