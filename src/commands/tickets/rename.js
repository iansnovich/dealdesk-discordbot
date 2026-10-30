const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// DealDesk ticket command; only works inside a DealDesk ticket channel.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('rename')
        .setDescription('Rename this ticket channel.')
        .setDMPermission(false)
        .addStringOption(o => o.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(90)),
    async execute(interaction) {
        return t.rename(interaction, interaction.options.getString('name', true));
    }
};
