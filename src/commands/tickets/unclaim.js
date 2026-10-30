const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// DealDesk ticket command; only works inside a DealDesk ticket channel.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('unclaim')
        .setDescription('Release this ticket back to the open queue.')
        .setDMPermission(false),
    async execute(interaction) {
        return t.unclaim(interaction);
    }
};
