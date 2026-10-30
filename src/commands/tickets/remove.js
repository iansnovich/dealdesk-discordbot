const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// DealDesk ticket command; only works inside a DealDesk ticket channel.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove someone from this ticket.')
        .setDMPermission(false)
        .addUserOption(o => o.setName('user').setDescription('Person to remove').setRequired(true)),
    async execute(interaction) {
        return t.removeUser(interaction, interaction.options.getUser('user', true));
    }
};
