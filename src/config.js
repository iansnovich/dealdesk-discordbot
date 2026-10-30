// Server-specific IDs live in config.json (git-ignored). Copy config.example.json
// to config.json and fill in your own guild, channel and role IDs.
const fs = require('node:fs');
const path = require('node:path');

const local = path.join(__dirname, '..', 'config.json');
const file = fs.existsSync(local) ? local : path.join(__dirname, '..', 'config.example.json');
module.exports = JSON.parse(fs.readFileSync(file, 'utf8'));
