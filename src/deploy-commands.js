// Registers the slash commands for the configured server. Run once after
// changing a command's options: `npm run deploy`.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { guildId } = require('./config');

const body = [];
const root = path.join(__dirname, 'commands');
for (const folder of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, folder)).filter(f => f.endsWith('.js'))) {
        const command = require(path.join(root, folder, file));
        if (command.data) body.push(command.data.toJSON());
    }
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body })
    .then(saved => console.log(`Registered ${saved.length} commands.`))
    .catch(error => { console.error(error); process.exit(1); });
