const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const t = require('../../Tickets');
const { PANELS, SETTINGS } = require('../../TicketPanels');

const panelChoice = option => option.setName('panel').setDescription('Which panel').setRequired(true)
    .addChoices(...Object.values(PANELS).map(p => ({ name: p.title.trim(), value: p.key })));

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket-panel')
        .setDescription('Set up DealDesk ticket panels.')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(c => c.setName('post').setDescription('Post a ticket panel.')
            .addStringOption(panelChoice)
            .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to the panel’s usual channel)').addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(c => c.setName('enable').setDescription('Let people open tickets from a panel.').addStringOption(panelChoice))
        .addSubcommand(c => c.setName('disable').setDescription('Stop new tickets from a panel.').addStringOption(panelChoice))
        .addSubcommand(c => c.setName('numbering').setDescription('Set the number the next ticket gets.')
            .addIntegerOption(o => o.setName('next').setDescription('Next ticket number').setRequired(true).setMinValue(1)))
        .addSubcommand(c => c.setName('status').setDescription('Show the ticket system setup.')),

    async execute(interaction) {
        const reply = content => (interaction.deferred || interaction.replied)
            ? interaction.editReply({ content, allowedMentions: { parse: [] } })
            : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        if (interaction.guildId !== SETTINGS.guildId) return reply('Tickets are only set up for the DealDesk server.');
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return reply('Only server managers can change ticket panels.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'post') {
                const key = interaction.options.getString('panel', true);
                const channel = interaction.options.getChannel('channel');
                const message = await t.postPanel(interaction.guild, key, channel?.id);
                return reply(`Posted the **${PANELS[key].title.trim()}** panel: ${message.url}${await t.isDisabled(interaction.guildId, key) ? '\nIt is currently **disabled**; use `/ticket-panel enable` to open it.' : ''}`);
            }
            if (sub === 'enable' || sub === 'disable') {
                const key = interaction.options.getString('panel', true);
                await t.setDisabled(interaction.guild, key, sub === 'disable');
                return reply(`**${PANELS[key].title.trim()}** is now ${sub === 'disable' ? 'disabled' : 'enabled'}.`);
            }
            if (sub === 'numbering') {
                const next = interaction.options.getInteger('next', true);
                await t.State().updateOne({ _id: interaction.guildId }, { $set: { created: next - SETTINGS.firstNumber } }, { upsert: true });
                return reply(`The next ticket will be **#${next}**.`);
            }
            const state = await t.State().findById(interaction.guildId).lean();
            const open = await t.Tickets().countDocuments({ guildId: interaction.guildId, status: 'open' });
            const lines = await Promise.all(Object.values(PANELS).map(async p => {
                const s = state?.panels?.[p.key];
                const where = s?.messageId ? `https://discord.com/channels/${interaction.guildId}/${s.channelId}/${s.messageId}` : 'not posted yet';
                return `**${p.title.trim()}**: ${await t.isDisabled(interaction.guildId, p.key) ? 'disabled' : 'enabled'} · ${where}`;
            }));
            return reply([
                '**DealDesk tickets**', ...lines,
                `Next ticket number: **#${SETTINGS.firstNumber + (state?.created || 0)}**`,
                `Open tickets: **${open}** · Limit per member: **${SETTINGS.perUserLimit}**`,
                `Transcripts: <#${SETTINGS.transcriptChannelId}>`
            ].join('\n'));
        } catch (error) {
            console.error('[Tickets] Panel command failed:', error.message);
            return reply(`Could not do that: ${error.message}`);
        }
    }
};
