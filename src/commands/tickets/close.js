const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// DealDesk ticket command; only works inside a DealDesk ticket channel.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close this ticket and save its transcript.')
        .setDMPermission(false)
        .addStringOption(o => o.setName('reason').setDescription('Why the ticket is being closed').setMaxLength(1000)),
    async execute(interaction) {
        return t.closeCommand(interaction, interaction.options.getString('reason'));
    }
};
