const mongoose = require('mongoose');
const { PermissionFlagsBits, ChannelType } = require('discord.js');

const cfg = require('./config');
const TARGET_GUILD = cfg.guildId;
const TICKET_BOT = cfg.ticketsV2BotId;
const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    sourceCategoryId: { type: String, default: null },
    maxTicketsPerDealer: { type: Number, default: 10, min: 1, max: 50 },
    sellers: [{ userId: { type: String, required: true }, categoryId: { type: String, required: true } }]
}, { timestamps: true, bufferCommands: false });

function getModel() {
    if (mongoose.connection.readyState !== 1) throw new Error('Database unavailable');
    return mongoose.models.DealerTicketQueue
        || mongoose.model('DealerTicketQueue', schema);
}

// Claim history for /dealersummary ticket stats.
const claimSchema = new mongoose.Schema({
    channelId: { type: String, index: true }, dealerId: { type: String, index: true },
    ticketCreatedAt: Date, claimedAt: { type: Date, index: true }, unclaimedAt: Date, closedAt: Date
}, { bufferCommands: false });
function claimModel() {
    if (mongoose.connection.readyState !== 1) throw new Error('Database unavailable');
    return mongoose.models.TicketClaim || mongoose.model('TicketClaim', claimSchema);
}
const isOpenClaim = { unclaimedAt: null, closedAt: null };

async function recordClaim(channel, dealerId) {
    const Claims = claimModel();
    const open = await Claims.findOne({ channelId: channel.id, ...isOpenClaim }).lean();
    if (open?.dealerId === dealerId) return; // same claim seen again (message edit)
    if (open) await Claims.updateOne({ _id: open._id }, { $set: { unclaimedAt: new Date() } });
    await Claims.create({ channelId: channel.id, dealerId, ticketCreatedAt: channel.createdAt, claimedAt: new Date() });
}
async function recordUnclaim(channelId) {
    await claimModel().updateMany({ channelId, ...isOpenClaim }, { $set: { unclaimedAt: new Date() } });
}
async function recordClose(channelId) {
    await claimModel().updateMany({ channelId, ...isOpenClaim }, { $set: { closedAt: new Date() } });
}

// Ticket stats for one dealer. `range` is an optional Mongo date filter on claimedAt.
async function dealerTicketStats(dealerId, range) {
    const Claims = claimModel();
    const match = { dealerId, ...(range ? { claimedAt: range } : {}) };
    const [row] = await Claims.aggregate([
        { $match: match },
        { $group: {
            _id: null,
            claimed: { $sum: 1 },
            unclaimed: { $sum: { $cond: [{ $ifNull: ['$unclaimedAt', false] }, 1, 0] } },
            closed: { $sum: { $cond: [{ $ifNull: ['$closedAt', false] }, 1, 0] } },
            claimMs: { $avg: { $subtract: ['$claimedAt', '$ticketCreatedAt'] } },
            closeMs: { $avg: { $cond: [{ $ifNull: ['$closedAt', false] }, { $subtract: ['$closedAt', '$claimedAt'] }, null] } }
        } }
    ]);
    const openNow = await Claims.countDocuments({ dealerId, ...isOpenClaim });
    return { claimed: row?.claimed || 0, unclaimed: row?.unclaimed || 0, closed: row?.closed || 0, avgClaimMs: row?.claimMs ?? null, avgCloseMs: row?.closeMs ?? null, openNow };
}

const busy = new Set();
const DEFAULT_LIMIT = 10;
const limitNotices = new Map(); // channelId -> last notice time, so one claim posts one notice

// Tells the dealer their category is full; the ticket stays in the open queue.
async function notifyLimit(channel, dealerId, held, limit) {
    const last = limitNotices.get(channel.id) || 0;
    if (Date.now() - last < 10 * 60_000) return;
    limitNotices.set(channel.id, Date.now());
    await channel.send({
        content: `<@${dealerId}>`,
        embeds: [{
            title: 'Ticket limit reached',
            color: 0xe67e22,
            description: `You already have **${held}** tickets in your category (limit **${limit}**), so this ticket stays in the open queue.\n` +
                'Please run **/unclaim** here so another dealer can take it. Close one of your tickets before claiming more.'
        }],
        allowedMentions: { users: [dealerId] }
    }).catch(error => console.warn('[Dealer ticket queue] Could not post limit notice:', error.name));
    console.log(`[Dealer ticket queue] ${dealerId} is at ${held}/${limit}; left ${channel.id} in the open queue`);
}

function parseClaimAnnouncement(message) {
    if (message.guildId !== TARGET_GUILD || message.author?.id !== TICKET_BOT || !message.author.bot) return null;
    const embeds = message.embeds || [];

    // Tickets v2's /claim reply (verified live): embed title "Claimed Ticket",
    // description "Your ticket will be handled by <@claimer>".
    const claimEmbed = embeds.find(embed => /^\s*claimed\s+ticket\s*$/i.test(embed.title || ''));
    if (claimEmbed) {
        const mentioned = String(claimEmbed.description || '').match(/<@!?(\d+)>/)?.[1];
        // Fall back to whoever ran /claim if the mention is missing.
        return mentioned || message.interactionMetadata?.user?.id || message.interaction?.user?.id || null;
    }

    const text = [message.content, ...embeds.flatMap(embed => [
        embed.title, embed.description,
        ...(embed.fields || []).flatMap(field => [field.name, field.value])
    ])].filter(Boolean).join('\n');
    if (/\bunclaim/i.test(text)) return null;
    const match = text.match(/(?:claimed\s+by|assigned\s+to|handled\s+by|<@!?(\d+)>\s+(?:has\s+)?claimed(?:\s+this)?\s+ticket)/i);
    if (!match) return null;
    if (match[1]) return match[1];
    const start = match.index + match[0].length;
    return text.slice(start).match(/<@!?(\d+)>/)?.[1] || null;
}

// Tickets v2's /unclaim reply (verified live): embed title "Unclaimed Ticket".
function isUnclaimAnnouncement(message) {
    if (message.guildId !== TARGET_GUILD || message.author?.id !== TICKET_BOT || !message.author.bot) return false;
    return (message.embeds || []).some(embed => /^\s*unclaimed\s+ticket\s*$/i.test(embed.title || ''));
}

function addedSendPermission(oldChannel, newChannel) {
    const previous = oldChannel.permissionOverwrites?.cache;
    const current = newChannel.permissionOverwrites?.cache;
    if (!previous || !current) return [];

    const added = [];
    for (const [id, overwrite] of current) {
        // Tickets v2 grants the claimer a member-specific Send Messages allow
        // when its claim policy changes the ticket's access.
        if (overwrite.type !== 1 || !overwrite.allow.has(PermissionFlagsBits.SendMessages)) continue;
        const before = previous.get(id);
        if (!before || !before.allow.has(PermissionFlagsBits.SendMessages)) added.push(id);
    }
    return added;
}

async function moveTicket(channel, sellerId, categoryId, reason) {
    if (!channel?.guild || channel.guild.id !== TARGET_GUILD || channel.type !== ChannelType.GuildText) return false;
    if (channel.parentId === categoryId) return true;

    const category = await channel.guild.channels.fetch(categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== channel.guild.id) return false;
    const me = channel.guild.members.me || await channel.guild.members.fetchMe().catch(() => null);
    if (!me?.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) return false;

    // Keep the Tickets v2 channel's own opener/staff overwrites intact. Syncing
    // to the destination category could silently replace its ticket access.
    await channel.setParent(category.id, { lockPermissions: false, reason });
    console.log(`[Dealer ticket queue] Moved ${channel.id} to ${category.id} for ${sellerId}`);
    return true;
}

async function onChannelUpdate(oldChannel, newChannel) {
    if (mongoose.connection.readyState !== 1) return;
    if (newChannel.guildId !== TARGET_GUILD || newChannel.type !== ChannelType.GuildText) return;
    // DealDesk's own tickets route themselves on /claim; adding people must not look like a claim.
    if (require('./Tickets').isNative(newChannel.id)) return;
    const config = await getModel().findById(TARGET_GUILD).lean().catch(() => null);
    const sourceCategoryId = config?.sourceCategoryId;
    if (!sourceCategoryId || oldChannel.parentId !== sourceCategoryId || newChannel.parentId !== sourceCategoryId) return;

    const claimers = addedSendPermission(oldChannel, newChannel);
    if (!claimers.length || busy.has(newChannel.id)) return;
    busy.add(newChannel.id);
    try {
        await routeClaim(newChannel, claimers, config);
    } catch (error) {
        console.error('[Dealer ticket queue] Automatic route failed:', error.name);
    } finally {
        busy.delete(newChannel.id);
    }
}

async function routeClaim(channel, claimerIds, config) {
    if (!config?.sourceCategoryId || channel.parentId !== config.sourceCategoryId) return false;
    for (const claimerId of claimerIds) {
        const seller = config.sellers?.find(entry => entry.userId === claimerId);
        if (!seller) continue;
        const limit = config.maxTicketsPerDealer || DEFAULT_LIMIT;
        const held = channel.guild.channels.cache?.filter(c => c.parentId === seller.categoryId && c.type === ChannelType.GuildText && c.id !== channel.id).size ?? 0;
        if (held >= limit) {
            await notifyLimit(channel, claimerId, held, limit);
            return false;
        }
        const moved = await moveTicket(channel, claimerId, seller.categoryId, 'Route claimed ticket to the seller category');
        if (!moved) console.warn(`[Dealer ticket queue] Could not route ${channel.id} for ${claimerId}; check category and Manage Channels permission`);
        return moved;
    }
    return false;
}

// An unclaimed ticket goes back to the open-ticket category so the next
// dealer's claim routes it again.
async function onUnclaim(channel) {
    await recordUnclaim(channel.id).catch(error => console.error('[Dealer ticket queue] Unclaim record failed:', error.name));
    const config = await getModel().findById(TARGET_GUILD).lean().catch(() => null);
    const source = config?.sourceCategoryId;
    if (!source || channel.parentId === source) return false;
    const inDealerCategory = (config.sellers || []).some(seller => seller.categoryId === channel.parentId);
    if (!inDealerCategory) return false;
    const moved = await moveTicket(channel, 'unclaimed', source, 'Ticket unclaimed: back to the open queue');
    if (!moved) console.warn(`[Dealer ticket queue] Could not return ${channel.id} to the open queue; check Manage Channels permission`);
    return moved;
}

async function onClaimMessage(message) {
    if (mongoose.connection.readyState !== 1) return;
    if (message.channel?.type === ChannelType.GuildText && isUnclaimAnnouncement(message) && !busy.has(message.channel.id)) {
        busy.add(message.channel.id);
        try { await onUnclaim(message.channel); }
        catch (error) { console.error('[Dealer ticket queue] Unclaim route failed:', error.name); }
        finally { busy.delete(message.channel.id); }
        return;
    }
    const claimerId = parseClaimAnnouncement(message);
    if (claimerId && message.channel?.type === ChannelType.GuildText) {
        await recordClaim(message.channel, claimerId).catch(error => console.error('[Dealer ticket queue] Claim record failed:', error.name));
    }
    if (!claimerId || !message.channel?.guild || message.channel.type !== ChannelType.GuildText || busy.has(message.channel.id)) return;
    const config = await getModel().findById(TARGET_GUILD).lean().catch(() => null);
    if (!config?.sourceCategoryId || message.channel.parentId !== config.sourceCategoryId) return;
    busy.add(message.channel.id);
    try {
        await routeClaim(message.channel, [claimerId], config);
    } catch (error) {
        console.error('[Dealer ticket queue] Claim message route failed:', error.name);
    } finally {
        busy.delete(message.channel.id);
    }
}

function install(client) {
    client.on('channelUpdate', (oldChannel, newChannel) => { void onChannelUpdate(oldChannel, newChannel); });
    client.on('messageCreate', message => { void onClaimMessage(message); });
    client.on('messageUpdate', (_old, message) => { if (!message.partial) void onClaimMessage(message); });
    client.on('channelDelete', channel => { if (channel.guildId === TARGET_GUILD) recordClose(channel.id).catch(() => {}); });
}

module.exports = { DEFAULT_LIMIT, getModel, claimModel, addedSendPermission, parseClaimAnnouncement, isUnclaimAnnouncement, moveTicket, onChannelUpdate, onClaimMessage, onUnclaim, recordClaim, recordUnclaim, recordClose, dealerTicketStats, install };
