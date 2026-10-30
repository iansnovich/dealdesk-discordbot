const { SlashCommandBuilder } = require('discord.js');
const t = require('../../Tickets');

// Ask the opener to confirm closing; closes on its own if they don't answer.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('closerequest')
        .setDescription('Ask the buyer to confirm closing this ticket (auto-closes if they do not reply).')
        .setDMPermission(false)
        .addStringOption(o => o.setName('reason').setDescription('Why the ticket can be closed').setMaxLength(1000))
        .addIntegerOption(o => o.setName('hours').setDescription('Hours to wait before closing automatically (default 24)').setMinValue(1).setMaxValue(168)),
    async execute(interaction) {
        return t.closeRequest(interaction, interaction.options.getString('reason'), interaction.options.getInteger('hours'));
    }
};
