const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// Opens (or joins) a private staff-only thread inside the ticket.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Open the private staff notes thread for this ticket.')
        .setDMPermission(false),
    async execute(interaction) {
        return t.notes(interaction);
    }
};
