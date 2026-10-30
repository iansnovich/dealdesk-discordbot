// Discord user -> linked Roblox account. In production this is filled by a
// Roblox OAuth "link your account" flow; here it is just the lookup.
const mongoose = require('mongoose');

const schema = new mongoose.Schema({ _id: String, robloxId: String, linkedAt: Date }, { bufferCommands: false });
const Link = () => mongoose.models.RobloxLink || mongoose.model('RobloxLink', schema);

async function linkedUser(discordId) {
    const row = await Link().findById(discordId).lean().maxTimeMS(5000);
    return row?.robloxId || null;
}

module.exports = { linkedUser, Link };
