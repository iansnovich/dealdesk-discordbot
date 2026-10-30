const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const t = require('../../Tickets');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket-blacklist')
        .setDescription('Stop someone from opening DealDesk tickets.')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(c => c.setName('add').setDescription('Block someone from opening tickets.')
            .addUserOption(o => o.setName('user').setDescription('Person to block').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(300)))
        .addSubcommand(c => c.setName('remove').setDescription('Let someone open tickets again.')
            .addUserOption(o => o.setName('user').setDescription('Person to unblock').setRequired(true)))
        .addSubcommand(c => c.setName('list').setDescription('Show everyone who is blocked.')),
    async execute(interaction) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'Only server managers can change the ticket blacklist.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        let content;
        if (sub === 'add') content = await t.blacklistAdd(interaction, interaction.options.getUser('user', true), interaction.options.getString('reason'));
        else if (sub === 'remove') content = await t.blacklistRemove(interaction, interaction.options.getUser('user', true));
        else content = await t.blacklistList();
        return interaction.editReply({ content, allowedMentions: { parse: [] } });
    }
};
