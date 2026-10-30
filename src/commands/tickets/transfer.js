const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// DealDesk ticket command; only works inside a DealDesk ticket channel.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('transfer')
        .setDescription('Hand this ticket to another staff member.')
        .setDMPermission(false)
        .addUserOption(o => o.setName('user').setDescription('Staff member to take over').setRequired(true)),
    async execute(interaction) {
        return t.transfer(interaction, interaction.options.getUser('user', true));
    }
};
