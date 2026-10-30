const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// DealDesk ticket command; only works inside a DealDesk ticket channel.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add someone to this ticket.')
        .setDMPermission(false)
        .addUserOption(o => o.setName('user').setDescription('Person to add').setRequired(true)),
    async execute(interaction) {
        return t.addUser(interaction, interaction.options.getUser('user', true));
    }
};
