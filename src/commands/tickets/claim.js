const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// DealDesk ticket command; only works inside a DealDesk ticket channel.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('claim')
        .setDescription('Claim this ticket (moves it to your category for mapped dealers).')
        .setDMPermission(false),
    async execute(interaction) {
        return t.claim(interaction);
    }
};
