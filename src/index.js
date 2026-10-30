// DealDesk: a Discord bot for running a Roblox (Robux) shop server.
// Ticket system with forms, transcripts and a web dashboard; dealer routing;
// purchase logging with automatic buyer tiers; dot-prefix versions of every
// slash command.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { Client, Collection, Events, GatewayIntentBits, EmbedBuilder, Partials, MessageFlags } = require('discord.js');

require('./DiscordTheme').install({ EmbedBuilder });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

const tickets = require('./Tickets');
const ticketRoblox = require('./TicketRoblox');
ticketRoblox.install(client);
require('./DealerTicketQueue').install(client);
require('./PrefixCommands').install(client);
tickets.install(client);

// ---- slash commands: every file in src/commands/<folder>/ exporting { data, execute }
client.commands = new Collection();
const commandsRoot = path.join(__dirname, 'commands');
for (const folder of fs.readdirSync(commandsRoot)) {
    for (const file of fs.readdirSync(path.join(commandsRoot, folder)).filter(f => f.endsWith('.js'))) {
        const command = require(path.join(commandsRoot, folder, file));
        if (command.data && command.execute) client.commands.set(command.data.name, command);
        else console.warn(`[Commands] ${folder}/${file} is missing data or execute`);
    }
}

// ---- interactions
const cooldowns = new Map();
const COOLDOWN_MS = 3000;

client.on(Events.InteractionCreate, async interaction => {
    const id = interaction.customId || '';
    if ((interaction.isButton() || interaction.isModalSubmit()) && id.startsWith('tk:')) return tickets.handleComponent(interaction);
    if ((interaction.isButton() || interaction.isModalSubmit()) && id.startsWith('ticket_rblx:')) return ticketRoblox.handle(interaction);
    if ((interaction.isButton() || interaction.isStringSelectMenu()) && id.startsWith('unlog:')) return client.commands.get('unlogpurchase')?.handleComponent(interaction);
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    const key = `${interaction.user.id}:${interaction.commandName}`;
    const last = cooldowns.get(key);
    if (last && Date.now() - last < COOLDOWN_MS) {
        return interaction.reply({ content: `Slow down! Try \`/${interaction.commandName}\` again in a moment.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    cooldowns.set(key, Date.now());
    setTimeout(() => cooldowns.delete(key), COOLDOWN_MS).unref();

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(`[Commands] /${interaction.commandName} failed:`, error);
        if (interaction.deferred && !interaction.replied) {
            await require('./DiscordResults').showResult(interaction, { content: 'This command could not be completed. Check its result before retrying.' }).catch(() => {});
        } else {
            const reply = { content: 'Something went wrong running this command.', flags: MessageFlags.Ephemeral };
            await (interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
        }
    }
});

// ---- web: online transcripts + staff dashboard (only when a public URL is set)
function startWeb() {
    if (!process.env.PUBLIC_URL) return console.log('[Web] PUBLIC_URL not set; transcripts are file-only and the dashboard is off.');
    const express = require('express');
    const app = express();
    app.disable('x-powered-by');
    tickets.installWeb(app, client);
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => console.log(`[Web] Transcripts and dashboard listening on :${port}`));
}

client.once(Events.ClientReady, ready => {
    console.log(`Ready! Logged in as ${ready.user.tag}`);
    startWeb();
});

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('[DB] Connected');
    await client.login(process.env.DISCORD_TOKEN);
})().catch(error => {
    console.error('Startup failed:', error.message);
    process.exit(1);
});
