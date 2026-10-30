// DealDesk's own ticket system (replaces Tickets v2). Mirrors the Tickets v2
// setup in TicketPanels.js: panel button -> form -> private ticket channel,
// /claim (with dealer routing + per-dealer limit), /unclaim, /transfer,
// /add, /remove, /rename, close (with confirmation / reason), HTML
// transcripts to the transcript channel + the opener's DMs, auto-close when
// the opener leaves. Panel embeds are sent as plain objects so the gold
// DiscordTheme does not recolour them.
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
    ChannelType, PermissionFlagsBits: P, MessageFlags, AttachmentBuilder, Events
} = require('discord.js');
const { PANELS, SETTINGS } = require('./TicketPanels');
const queue = require('./DealerTicketQueue');

const GREEN = 0x2ecc71, RED = 0xe74c3c, ORANGE = 0xe67e22;
const CLOSE_DELAY_MS = 5000;

// ---------- storage ----------
const ticketSchema = new mongoose.Schema({
    _id: String, // channel id
    guildId: String,
    panel: String,
    number: Number,
    ownerId: { type: String, index: true },
    status: { type: String, default: 'open', index: true }, // open | closing | closed
    openedAt: Date,
    form: [{ _id: false, label: String, value: String }],
    claimedBy: { type: String, default: null },
    claimedAt: Date,
    closedAt: Date,
    closedBy: String,
    closeReason: String,
    transcriptUrl: String,
    ownerName: String,
    rating: Number,
    ratedAt: Date,
    logChannelId: String,
    logMessageId: String,
    notesThreadId: String,
    closeRequest: { type: Object, default: null } // { by, reason, deadline, messageId }
}, { bufferCommands: false });
const blacklistSchema = new mongoose.Schema({ _id: String, guildId: String, reason: String, by: String, at: Date }, { bufferCommands: false });
const stateSchema = new mongoose.Schema({
    _id: String,
    created: { type: Number, default: 0 }, // tickets created; number = firstNumber - 1 + created
    panels: { type: Object, default: {} }   // key -> { disabled, channelId, messageId }
}, { bufferCommands: false, minimize: false });

const transcriptSchema = new mongoose.Schema({
    _id: String, // random token used in the public link
    ticketId: { type: String, index: true },
    guildId: String,
    name: String,
    html: String,
    createdAt: { type: Date, default: Date.now }
}, { bufferCommands: false });
function Transcripts() {
    if (!dbReady()) throw new Error('Database unavailable');
    return mongoose.models.Transcript || mongoose.model('Transcript', transcriptSchema);
}
const transcriptBase = () => (require('./WebGateway').PUBLIC_URL || '').replace(/\/$/, '');
const linkButton = url => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View Online Transcript').setURL(url);
const linkRow = url => new ActionRowBuilder().addComponents(linkButton(url));
function logRow(onlineUrl, channelId) {
    const row = new ActionRowBuilder();
    if (onlineUrl) row.addComponents(linkButton(onlineUrl));
    return row.addComponents(new ButtonBuilder().setCustomId(`tk:editreason:${channelId}`).setLabel('Edit Reason').setEmoji('✏️').setStyle(ButtonStyle.Secondary));
}
const STARS = n => '⭐'.repeat(n);
function ratingRow(channelId, chosen) {
    return new ActionRowBuilder().addComponents([1, 2, 3, 4, 5].map(n => new ButtonBuilder()
        .setCustomId(`tk:rate:${channelId}:${n}`).setLabel(`${n}`).setEmoji('⭐')
        .setStyle(chosen === n ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!!chosen)));
}

function dbReady() { return mongoose.connection.readyState === 1; }
function Tickets() {
    if (!dbReady()) throw new Error('Database unavailable');
    return mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);
}
function Blacklist() {
    if (!dbReady()) throw new Error('Database unavailable');
    return mongoose.models.TicketBlacklist || mongoose.model('TicketBlacklist', blacklistSchema);
}
function State() {
    if (!dbReady()) throw new Error('Database unavailable');
    return mongoose.models.TicketState || mongoose.model('TicketState', stateSchema);
}

const openChannels = new Set(); // channel ids of open native tickets (for DealerTicketQueue)
const isNative = id => openChannels.has(id);

// ---------- helpers ----------
const fill = (text, vars) => String(text || '')
    .replace(/%user%/g, vars.user ?? '')
    .replace(/%username%/g, vars.username ?? '')
    .replace(/%id%/g, vars.id ?? '');
const channelName = (pattern, vars) => fill(pattern, vars).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'ticket';
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ephemeral = (i, content, extra = {}) => {
    const body = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }, ...extra };
    return (i.deferred || i.replied) ? i.editReply(body) : i.reply(body);
};
const isAdmin = member => !!member?.permissions?.has(P.Administrator) || !!member?.permissions?.has(P.ManageGuild);
function isStaff(member, panel) {
    if (!member) return false;
    if (isAdmin(member) || member.permissions?.has(P.ManageChannels)) return true;
    return (panel?.support || []).some(id => member.roles?.cache?.has(id));
}
async function panelState(guildId) {
    const doc = await State().findById(guildId).lean();
    return doc?.panels || {};
}
async function isDisabled(guildId, key) {
    const state = (await panelState(guildId))[key];
    return typeof state?.disabled === 'boolean' ? state.disabled : !!PANELS[key]?.disabled;
}
async function dealerRoute(guildId, userId) {
    const config = await queue.getModel().findById(guildId).lean().catch(() => null);
    const seller = config?.sellers?.find(s => s.userId === userId) || null;
    return { config, seller, limit: config?.maxTicketsPerDealer || queue.DEFAULT_LIMIT || 10 };
}
function heldIn(guild, categoryId, exceptId) {
    return guild.channels.cache.filter(c => c.parentId === categoryId && c.type === ChannelType.GuildText && c.id !== exceptId).size;
}
// Discord allows 50 channels per category. When a panel's category is full, new
// tickets go to an overflow category (created on demand with the same permissions).
const CATEGORY_LIMIT = 50;
const childCount = (guild, categoryId) => guild.channels.cache.filter(c => c.parentId === categoryId).size;
async function panelCategoryIds(guildId, panel) {
    const overflow = (await panelState(guildId))[panel.key]?.overflow || [];
    return [panel.categoryId, ...overflow];
}
async function categoryWithRoom(guild, panel) {
    const ids = await panelCategoryIds(guild.id, panel);
    for (const id of ids) {
        const category = guild.channels.cache.get(id);
        if (category && childCount(guild, id) < CATEGORY_LIMIT) return id;
    }
    const base = guild.channels.cache.get(panel.categoryId);
    if (!base) return panel.categoryId;
    const overflow = await guild.channels.create({
        name: `${base.name} ${ids.length + 1}`.slice(0, 100),
        type: ChannelType.GuildCategory,
        position: base.position + ids.length,
        permissionOverwrites: base.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })),
        reason: `Overflow for ${panel.title.trim()} tickets (category full)`
    });
    await State().updateOne({ _id: guild.id }, { $push: { [`panels.${panel.key}.overflow`]: overflow.id } }, { upsert: true });
    console.log(`[Tickets] Created overflow category ${overflow.id} for ${panel.key}`);
    return overflow.id;
}
// Where an unclaimed ticket should live: stay if already in one of the panel's categories.
async function openQueueFor(channel, panel) {
    const ids = await panelCategoryIds(channel.guild.id, panel);
    if (ids.includes(channel.parentId)) return null;
    return categoryWithRoom(channel.guild, panel);
}

const userAllow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.UseExternalEmojis, P.SendVoiceMessages];
const staffAllow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.UseExternalEmojis];

// ---------- panel ----------
function panelMessage(panel, disabled) {
    const embed = { title: panel.title, description: panel.content, color: panel.colour };
    if (panel.imageUrl) embed.image = { url: panel.imageUrl };
    const button = new ButtonBuilder().setCustomId(`tk:open:${panel.key}`).setLabel(panel.buttonLabel)
        .setStyle(ButtonStyle.Primary).setDisabled(!!disabled);
    if (panel.emoji) button.setEmoji(panel.emoji);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [] } };
}

async function postPanel(guild, key, channelId) {
    const panel = PANELS[key];
    if (!panel) throw new Error('Unknown panel');
    const channel = await guild.channels.fetch(channelId || panel.channelId).catch(() => null);
    if (!channel?.isTextBased()) throw new Error('Panel channel not found');
    const disabled = await isDisabled(guild.id, key);
    const message = await channel.send(panelMessage(panel, disabled));
    await State().updateOne({ _id: guild.id }, { $set: { [`panels.${key}.channelId`]: channel.id, [`panels.${key}.messageId`]: message.id } }, { upsert: true });
    return message;
}

async function setDisabled(guild, key, disabled) {
    await State().updateOne({ _id: guild.id }, { $set: { [`panels.${key}.disabled`]: !!disabled } }, { upsert: true });
    const state = (await panelState(guild.id))[key];
    if (state?.channelId && state?.messageId) {
        const channel = await guild.channels.fetch(state.channelId).catch(() => null);
        await channel?.messages?.edit(state.messageId, panelMessage(PANELS[key], disabled)).catch(() => {});
    }
}

// ---------- opening ----------
async function openFormFor(i, key) {
    const panel = PANELS[key];
    if (!panel) return ephemeral(i, 'This panel no longer exists.');
    if (!dbReady()) return ephemeral(i, 'Tickets are temporarily unavailable. Please try again in a minute.');
    if (await isDisabled(i.guildId, key)) return ephemeral(i, 'This ticket panel is currently closed.');
    const member = i.member;
    const banned = await Blacklist().findById(i.user.id).lean();
    if (banned) return ephemeral(i, 'You are not allowed to open tickets. Contact a staff member if you think this is a mistake.');
    if (!isAdmin(member) && !(panel.canOpen || []).some(id => member?.roles?.cache?.has(id))) {
        return ephemeral(i, 'You need to verify before opening a ticket. Press **Verify** in the verify channel first.');
    }
    const open = await Tickets().find({ guildId: i.guildId, ownerId: i.user.id, status: 'open' }).lean();
    if (open.length >= SETTINGS.perUserLimit) {
        return ephemeral(i, `You already have ${open.length} open ticket${open.length === 1 ? '' : 's'}: ${open.map(t => `<#${t._id}>`).join(', ')}. Please use ${open.length === 1 ? 'it' : 'one of them'}.`);
    }
    const modal = new ModalBuilder().setCustomId(`tk:form:${key}`).setTitle(panel.form.title.slice(0, 45));
    for (const field of panel.form.fields.slice(0, 5)) {
        const input = new TextInputBuilder().setCustomId(field.id).setLabel(field.label.trim().slice(0, 45))
            .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(!!field.required).setMaxLength(Math.min(field.max || 1024, 4000));
        if (field.placeholder) input.setPlaceholder(field.placeholder.slice(0, 100));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return i.showModal(modal);
}

async function createTicket(i, key) {
    const panel = PANELS[key];
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (!panel || await isDisabled(i.guildId, key)) return ephemeral(i, 'This ticket panel is currently closed.');
    const Store = Tickets();
    if (await Blacklist().findById(i.user.id).lean()) return ephemeral(i, 'You are not allowed to open tickets.');
    const open = await Store.countDocuments({ guildId: i.guildId, ownerId: i.user.id, status: 'open' });
    if (open >= SETTINGS.perUserLimit) return ephemeral(i, `You already have ${open} open tickets.`);

    const answers = panel.form.fields.map(f => ({ ...f, value: (i.fields.getTextInputValue(f.id) || '').trim() }));
    const state = await State().findOneAndUpdate({ _id: i.guildId }, { $inc: { created: 1 } }, { upsert: true, new: true }).lean();
    const number = SETTINGS.firstNumber - 1 + state.created;
    const guild = i.guild;
    const me = guild.members.me || await guild.members.fetchMe();

    const overwrites = [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: i.user.id, allow: userAllow },
        { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.ManageChannels, P.ManageMessages] },
        ...panel.support.filter(id => guild.roles.cache.has(id)).map(id => ({ id, allow: staffAllow }))
    ];
    let channel;
    try {
        channel = await guild.channels.create({
            name: channelName(panel.naming, { id: number, username: i.user.username }),
            type: ChannelType.GuildText,
            parent: await categoryWithRoom(guild, panel),
            topic: panel.topic,
            permissionOverwrites: overwrites,
            reason: `Ticket opened by ${i.user.id}`
        });
    } catch (error) {
        console.error('[Tickets] Could not create ticket channel:', error.code || error.message);
        const full = error.code === 50035 || /maximum number of channels/i.test(error.message || '');
        return ephemeral(i, full ? 'The ticket queue is full right now. Please try again a little later.' : 'Could not open your ticket. Please try again, or ask staff if it keeps failing.');
    }

    try {
        await Store.create({
            _id: channel.id, guildId: guild.id, panel: key, number, ownerId: i.user.id, ownerName: i.user.username, status: 'open', openedAt: new Date(),
            form: answers.map(a => ({ label: a.label.trim(), value: a.value }))
        });
        openChannels.add(channel.id);
        const welcome = { description: fill(panel.welcome.description, { user: `<@${i.user.id}>`, username: i.user.username, id: number }), color: panel.welcome.colour };
        const formEmbed = {
            color: panel.welcome.colour,
            fields: answers.map(a => ({ name: a.label.trim().slice(0, 256), value: (a.value || '*No response*').slice(0, 1024) }))
        };
        const opening = await channel.send({ embeds: [welcome, formEmbed], components: [ticketButtons(panel)], allowedMentions: { parse: [] } });
        const recipient = answers.find(a => a.robloxRecipient);
        if (recipient) {
            require('./TicketRoblox').begin({ guildId: guild.id, channel, ownerId: i.user.id, input: recipient.value, openingId: opening.id })
                .catch(() => console.error('[Tickets] Roblox account prompt failed'));
        }
    } catch (error) {
        console.error('[Tickets] Ticket setup failed:', error.code || error.message);
        openChannels.delete(channel.id);
        await Store.deleteOne({ _id: channel.id }).catch(() => {});
        await channel.delete('Ticket setup failed').catch(() => {});
        return ephemeral(i, 'Could not open your ticket. Please try again.');
    }
    return ephemeral(i, `Ticket opened: <#${channel.id}>`);
}

function ticketButtons(panel) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tk:closereason').setLabel('Close With Reason').setEmoji('🔒').setStyle(ButtonStyle.Danger)
    );
    if (panel.showClaimButton) row.addComponents(new ButtonBuilder().setCustomId('tk:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success));
    return row;
}

// ---------- ticket actions ----------
async function ticketFor(i) {
    if (!dbReady()) { await ephemeral(i, 'Tickets are temporarily unavailable. Please try again in a minute.'); return null; }
    const ticket = await Tickets().findById(i.channelId).lean();
    if (!ticket || ticket.status !== 'open') {
        await ephemeral(i, 'This command only works inside an open DealDesk ticket.');
        return null;
    }
    return { ticket, panel: PANELS[ticket.panel] || PANELS.robux };
}
async function announce(channel, title, description, color = GREEN) {
    return channel.send({ embeds: [{ title, description, color }], allowedMentions: { parse: [] } }).catch(() => null);
}

async function claim(i) {
    const found = await ticketFor(i); if (!found) return;
    const { ticket, panel } = found;
    if (!isStaff(i.member, panel)) return ephemeral(i, 'Only ticket staff can claim tickets.');
    if (ticket.claimedBy === i.user.id) return ephemeral(i, 'You already claimed this ticket.');
    if (ticket.claimedBy) return ephemeral(i, `This ticket is already claimed by <@${ticket.claimedBy}>. Ask them or an admin to use /transfer.`);
    const { seller, limit } = await dealerRoute(i.guildId, i.user.id);
    if (seller) {
        const held = heldIn(i.guild, seller.categoryId, i.channelId);
        if (held >= limit) return ephemeral(i, `You already have **${held}** tickets in your category (limit **${limit}**). Close one before claiming another.`);
    }
    const result = await Tickets().updateOne({ _id: i.channelId, status: 'open', claimedBy: null }, { $set: { claimedBy: i.user.id, claimedAt: new Date() } });
    if (!result.modifiedCount) return ephemeral(i, 'Someone else just claimed this ticket.');
    await i.channel.permissionOverwrites.edit(i.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }, { reason: 'Ticket claimed' }).catch(() => {});
    if (i.isButton?.()) await i.deferUpdate().catch(() => {}); else await ephemeral(i, 'Ticket claimed.');
    await announce(i.channel, 'Claimed Ticket', `Your ticket will be handled by <@${i.user.id}>`);
    if (seller) {
        const moved = await queue.moveTicket(i.channel, i.user.id, seller.categoryId, 'Route claimed ticket to the dealer category').catch(() => false);
        if (!moved) console.warn(`[Tickets] Could not move ${i.channelId} to ${seller.categoryId}`);
    }
    await queue.recordClaim(i.channel, i.user.id).catch(() => {});
}

async function unclaim(i) {
    const found = await ticketFor(i); if (!found) return;
    const { ticket, panel } = found;
    if (!ticket.claimedBy) return ephemeral(i, 'This ticket is not claimed.');
    if (ticket.claimedBy !== i.user.id && !isAdmin(i.member)) return ephemeral(i, `Only <@${ticket.claimedBy}> or an admin can unclaim this ticket.`);
    await Tickets().updateOne({ _id: i.channelId }, { $set: { claimedBy: null, claimedAt: null } });
    if (ticket.claimedBy !== ticket.ownerId) await i.channel.permissionOverwrites.delete(ticket.claimedBy, 'Ticket unclaimed').catch(() => {});
    await ephemeral(i, 'Ticket unclaimed.');
    await announce(i.channel, 'Unclaimed Ticket', 'All support representatives can now respond to the ticket');
    const back = await openQueueFor(i.channel, panel).catch(() => panel.categoryId);
    if (back) await queue.moveTicket(i.channel, 'unclaimed', back, 'Ticket unclaimed: back to the open queue').catch(() => false);
    await queue.recordUnclaim(i.channelId).catch(() => {});
}

async function transfer(i, target) {
    const found = await ticketFor(i); if (!found) return;
    const { ticket, panel } = found;
    if (!isStaff(i.member, panel)) return ephemeral(i, 'Only ticket staff can transfer tickets.');
    if (ticket.claimedBy && ticket.claimedBy !== i.user.id && !isAdmin(i.member)) return ephemeral(i, `Only <@${ticket.claimedBy}> or an admin can transfer this ticket.`);
    const member = await i.guild.members.fetch(target.id).catch(() => null);
    if (!member || member.user.bot || !isStaff(member, panel)) return ephemeral(i, 'You can only transfer to ticket staff.');
    if (ticket.claimedBy === member.id) return ephemeral(i, `<@${member.id}> already has this ticket.`);
    const { seller, limit } = await dealerRoute(i.guildId, member.id);
    if (seller) {
        const held = heldIn(i.guild, seller.categoryId, i.channelId);
        if (held >= limit) return ephemeral(i, `<@${member.id}> already has **${held}** tickets in their category (limit **${limit}**).`);
    }
    await Tickets().updateOne({ _id: i.channelId }, { $set: { claimedBy: member.id, claimedAt: new Date() } });
    if (ticket.claimedBy && ticket.claimedBy !== ticket.ownerId) await i.channel.permissionOverwrites.delete(ticket.claimedBy, 'Ticket transferred').catch(() => {});
    await i.channel.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }, { reason: 'Ticket transferred' }).catch(() => {});
    await ephemeral(i, `Ticket transferred to <@${member.id}>.`);
    await announce(i.channel, 'Claimed Ticket', `Your ticket will be handled by <@${member.id}>`);
    const destination = seller ? seller.categoryId : await openQueueFor(i.channel, panel).catch(() => null);
    if (destination && i.channel.parentId !== destination) await queue.moveTicket(i.channel, member.id, destination, 'Ticket transferred').catch(() => false);
    await queue.recordClaim(i.channel, member.id).catch(() => {});
}

async function addUser(i, user) {
    const found = await ticketFor(i); if (!found) return;
    if (!isStaff(i.member, found.panel)) return ephemeral(i, 'Only ticket staff can add people.');
    await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }, { reason: `Added by ${i.user.id}` });
    await ephemeral(i, `Added <@${user.id}>.`);
    await announce(i.channel, 'User Added', `<@${user.id}> has been added to the ticket by <@${i.user.id}>`);
}

async function removeUser(i, user) {
    const found = await ticketFor(i); if (!found) return;
    if (!isStaff(i.member, found.panel)) return ephemeral(i, 'Only ticket staff can remove people.');
    if (user.id === found.ticket.ownerId) return ephemeral(i, 'You cannot remove the ticket opener. Close the ticket instead.');
    await i.channel.permissionOverwrites.delete(user.id, `Removed by ${i.user.id}`).catch(() => {});
    await ephemeral(i, `Removed <@${user.id}>.`);
    await announce(i.channel, 'User Removed', `<@${user.id}> has been removed from the ticket by <@${i.user.id}>`, RED);
}

async function rename(i, name) {
    const found = await ticketFor(i); if (!found) return;
    if (!isStaff(i.member, found.panel)) return ephemeral(i, 'Only ticket staff can rename tickets.');
    const clean = channelName(name, {});
    try {
        await i.channel.setName(clean, `Renamed by ${i.user.id}`);
    } catch (error) {
        return ephemeral(i, error.status === 429 ? 'Discord only allows 2 renames per 10 minutes. Try again later.' : 'Could not rename this ticket.');
    }
    return ephemeral(i, `Renamed to **${clean}**.`);
}

// ---------- closing ----------
function canClose(member, ticket, panel, userId) {
    return isStaff(member, panel) || (panel.usersCanClose && userId === ticket.ownerId);
}

async function closeButton(i, withReason) {
    const found = await ticketFor(i); if (!found) return;
    const { ticket, panel } = found;
    if (!canClose(i.member, ticket, panel, i.user.id)) return ephemeral(i, 'Only staff can close this ticket.');
    if (withReason) {
        const modal = new ModalBuilder().setCustomId('tk:reasonmodal').setTitle('Close ticket').addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
        return i.showModal(modal);
    }
    if (panel.closeConfirmation) {
        return ephemeral(i, 'Are you sure you want to close this ticket?', {
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tk:closeconfirm').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger))]
        });
    }
    return startClose(i, ticket, panel, null);
}

async function closeCommand(i, reason) {
    const found = await ticketFor(i); if (!found) return;
    if (!canClose(i.member, found.ticket, found.panel, i.user.id)) return ephemeral(i, 'Only staff can close this ticket.');
    return startClose(i, found.ticket, found.panel, reason || null);
}

async function startClose(i, ticket, panel, reason) {
    if (i.isButton?.() && i.customId === 'tk:closeconfirm') await i.update({ content: 'Closing…', components: [] }).catch(() => {});
    else if (!i.deferred && !i.replied) await i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const result = await closeTicket(i.channel, ticket, panel, i.user, reason);
    if (!result.ok) {
        const msg = result.error || 'Could not close this ticket.';
        if (i.isButton?.() && i.customId === 'tk:closeconfirm') return i.editReply({ content: msg }).catch(() => {});
        return ephemeral(i, msg).catch(() => {});
    }
    if (!(i.isButton?.() && i.customId === 'tk:closeconfirm')) await ephemeral(i, 'Closing ticket…').catch(() => {});
}

// Closes and archives a ticket. Never deletes the channel unless the transcript was saved.
async function closeTicket(channel, ticket, panel, closer, reason) {
    const Store = Tickets();
    const lock = await Store.updateOne({ _id: channel.id, status: 'open' }, { $set: { status: 'closing' } });
    if (!lock.modifiedCount) return { ok: false, error: 'This ticket is already closing.' };
    try {
        await announce(channel, 'Closing Ticket', `This ticket will be closed in ${CLOSE_DELAY_MS / 1000} seconds.${reason ? `\n**Reason:** ${reason.slice(0, 1000)}` : ''}`, RED);
        const messages = await fetchAll(channel);
        const html = buildTranscript(channel, ticket, messages, { closer, reason });
        const fileName = `transcript-${channel.name}.html`;
        const summary = summaryEmbed(channel, ticket, panel, closer, reason, messages.length);

        const logChannel = await channel.guild.channels.fetch(SETTINGS.transcriptChannelId).catch(() => null);
        if (!logChannel?.isTextBased()) throw new Error('Transcript channel unavailable');
        // Online copy (best effort): the HTML file below is always attached as well.
        let onlineUrl = null;
        try {
            const token = crypto.randomBytes(24).toString('base64url');
            await Transcripts().create({ _id: token, ticketId: channel.id, guildId: channel.guild.id, name: channel.name, html: html.slice(0, 15_000_000) });
            if (transcriptBase()) onlineUrl = `${transcriptBase()}/transcript/${token}`;
        } catch (error) { console.error('[Tickets] Online transcript not saved:', error.message); }
        const logged = await logChannel.send({ embeds: [summary], files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName })], components: [logRow(onlineUrl, channel.id)], allowedMentions: { parse: [] } });
        const transcriptUrl = logged.attachments.first()?.url || logged.url;

        await Store.updateOne({ _id: channel.id }, { $set: { status: 'closed', closedAt: new Date(), closedBy: closer?.id || null, closeReason: reason || null, transcriptUrl: logged.url, logChannelId: logChannel.id, logMessageId: logged.id, closeRequest: null } });
        openChannels.delete(channel.id);
        dmOpener(channel.client, ticket, panel, summary, html, fileName, onlineUrl).catch(() => {});
        setTimeout(() => channel.delete(`Ticket closed by ${closer?.id || 'system'}`).catch(error => console.error('[Tickets] Delete failed:', error.code || error.message)), CLOSE_DELAY_MS);
        return { ok: true, transcriptUrl, onlineUrl };
    } catch (error) {
        console.error('[Tickets] Close failed:', error.code || error.message);
        await Store.updateOne({ _id: channel.id, status: 'closing' }, { $set: { status: 'open' } }).catch(() => {});
        await announce(channel, 'Close Cancelled', 'The transcript could not be saved, so the ticket was kept open. Please try again.', ORANGE);
        return { ok: false, error: 'The transcript could not be saved, so the ticket was kept open. Try again in a moment.' };
    }
}

function summaryEmbed(channel, ticket, panel, closer, reason, count) {
    const ts = d => d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>` : '—';
    return {
        title: `Ticket Closed · ${channel.name}`,
        color: RED,
        fields: [
            { name: 'Ticket', value: `#${ticket.number} · ${panel.title.trim()}`, inline: true },
            { name: 'Opened By', value: `<@${ticket.ownerId}>`, inline: true },
            { name: 'Claimed By', value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Not claimed', inline: true },
            { name: 'Closed By', value: closer ? `<@${closer.id}>` : 'System', inline: true },
            { name: 'Opened', value: ts(ticket.openedAt), inline: true },
            { name: 'Closed', value: ts(new Date()), inline: true },
            { name: 'Reason', value: (reason || 'No reason specified').slice(0, 1024) },
            { name: 'Messages', value: String(count), inline: true }
        ]
    };
}

async function dmOpener(client, ticket, panel, summary, html, fileName, onlineUrl) {
    const user = await client.users.fetch(ticket.ownerId).catch(() => null);
    if (!user) return;
    const embed = { ...summary, title: 'Your ticket was closed', description: 'Thanks for shopping with us. Your transcript is attached.' };
    if (panel.feedback) {
        const link = await feedbackLink(ticket.guildId).catch(() => null);
        if (link) embed.description += `\n\nHow did it go? [Leave a review](${link}). It takes a few seconds.`;
    }
    const components = [];
    if (onlineUrl) components.push(linkRow(onlineUrl));
    if (panel.feedback) {
        embed.description += '\n\nRate your experience with the buttons below.';
        components.push(ratingRow(ticket._id));
    }
    await user.send({ embeds: [embed], files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName })], components });
}

async function feedbackLink(guildId) {
    const { FeedbackConfig } = require('./FeedbackStore');
    const config = await FeedbackConfig.findOne({ guildId }).lean().catch(() => null);
    if (!config?.channelId) return null;
    return config.panelMessageId
        ? `https://discord.com/channels/${guildId}/${config.channelId}/${config.panelMessageId}`
        : `https://discord.com/channels/${guildId}/${config.channelId}`;
}

// ---------- transcripts ----------
async function fetchAll(channel, max = 5000) {
    const all = [];
    let before;
    while (all.length < max) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        all.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function renderText(text, message) {
    let html = escapeHtml(text);
    // Embeds don't fill message.mentions, so fall back to the member/user caches.
    const userName = id => message.mentions?.users?.get(id)?.username || message.guild?.members?.cache?.get(id)?.displayName || message.client?.users?.cache?.get(id)?.username || id;
    html = html.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${escapeHtml(userName(id))}</span>`);
    html = html.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention">@${escapeHtml(message.guild?.roles?.cache?.get(id)?.name || 'role')}</span>`);
    // [label](<https://...>) and [label](https://...)
    html = html.replace(/\[([^\]]+)\]\((?:&lt;)?(https?:\/\/[^\s)]+?)(?:&gt;)?\)/g, (_, label, url) => `<a href="${url}" rel="noopener noreferrer">${label}</a>`);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="mention">#${escapeHtml(message.guild?.channels?.cache?.get(id)?.name || id)}</span>`);
    html = html.replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    return html.replace(/\n/g, '<br>');
}

function buildTranscript(channel, ticket, messages, { closer, reason }) {
    const rows = messages.map(m => {
        const embeds = (m.embeds || []).map(e => `<div class="embed">${e.title ? `<div class="et">${renderText(e.title, m)}</div>` : ''}${e.description ? `<div>${renderText(e.description, m)}</div>` : ''}${(e.fields || []).map(f => `<div class="ef"><b>${renderText(f.name, m)}</b><br>${renderText(f.value, m)}</div>`).join('')}</div>`).join('');
        const files = [...(m.attachments?.values?.() || [])].map(a => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url)
            ? `<a href="${escapeHtml(a.url)}"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}"></a>`
            : `<a class="file" href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a>`).join('');
        const name = m.member?.displayName || m.author?.globalName || m.author?.username || 'Unknown';
        return `<div class="msg"><img class="av" src="${escapeHtml(m.author?.displayAvatarURL?.({ size: 64 }) || '')}" alt=""><div class="body"><div class="head"><span class="name">${escapeHtml(name)}</span>${m.author?.bot ? '<span class="bot">BOT</span>' : ''}<span class="time">${new Date(m.createdTimestamp).toUTCString()}</span></div>${m.content ? `<div>${renderText(m.content, m)}</div>` : ''}${embeds}${files}</div></div>`;
    }).join('\n');
    const form = (ticket.form || []).map(f => `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(f.value || '—')}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(channel.name)} transcript</title><style>
body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:20px 24px;background:#2b2d31;border-bottom:1px solid #111}h1{margin:0 0 6px;font-size:20px;color:#fff}
.meta{color:#949ba4;font-size:13px}table{margin-top:10px;border-collapse:collapse;font-size:13px}th{text-align:left;color:#b5bac1;padding:2px 12px 2px 0;font-weight:600}td{padding:2px 0}
main{padding:12px 16px}.msg{display:flex;gap:12px;padding:8px}.msg:hover{background:#2e3035}.av{width:40px;height:40px;border-radius:50%;flex:none}
.body{min-width:0}.head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.name{color:#fff;font-weight:600}.time{color:#949ba4;font-size:12px}
.bot{background:#5865f2;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px}.mention{background:#3c4270;color:#c9cdfb;border-radius:3px;padding:0 2px}
.embed{border-left:4px solid #4e5058;background:#2b2d31;border-radius:4px;padding:8px 12px;margin-top:6px;max-width:520px}.et{font-weight:700;color:#fff;margin-bottom:4px}.ef{margin-top:6px}
a{color:#00a8fc}code{background:#2b2d31;padding:0 4px;border-radius:3px;font-size:13px}
.body img:not(.av){max-width:360px;max-height:300px;border-radius:4px;margin-top:6px;display:block}.file{display:inline-block;margin-top:6px;color:#00a8fc}
</style></head><body><header><h1>#${escapeHtml(channel.name)}</h1><div class="meta">Ticket #${ticket.number} · opened ${new Date(ticket.openedAt).toUTCString()} · closed ${new Date().toUTCString()}${closer ? ` by ${escapeHtml(closer.username)}` : ''}${reason ? ` · reason: ${escapeHtml(reason)}` : ''} · ${messages.length} messages</div>${form ? `<table>${form}</table>` : ''}</header><main>
${rows}
</main></body></html>`;
}

// ---------- after-close actions ----------
async function updateLog(client, ticket, mutate) {
    if (!ticket.logChannelId || !ticket.logMessageId) return;
    const channel = await client.channels.fetch(ticket.logChannelId).catch(() => null);
    const message = await channel?.messages?.fetch(ticket.logMessageId).catch(() => null);
    if (!message?.embeds?.[0]) return;
    const embed = message.embeds[0].toJSON ? message.embeds[0].toJSON() : { ...message.embeds[0] };
    mutate(embed);
    await message.edit({ embeds: [embed] }).catch(() => {});
}
const setField = (embed, name, value, inline = false) => {
    embed.fields = embed.fields || [];
    const existing = embed.fields.find(f => f.name === name);
    if (existing) existing.value = value; else embed.fields.push({ name, value, inline });
};

// Star rating from the opener's DM (works outside the server).
async function rate(i, channelId, stars) {
    const ticket = await Tickets().findById(channelId).lean();
    if (!ticket || ticket.ownerId !== i.user.id) return ephemeral(i, 'Only the person who opened this ticket can rate it.');
    if (ticket.rating) return ephemeral(i, `You already rated this ticket ${STARS(ticket.rating)}.`);
    const n = Math.min(5, Math.max(1, Number(stars) || 0));
    const result = await Tickets().updateOne({ _id: channelId, rating: null }, { $set: { rating: n, ratedAt: new Date() } });
    if (!result.modifiedCount) return ephemeral(i, 'You already rated this ticket.');
    const rows = (i.message?.components || []).filter(r => !r.components?.some(c => String(c.customId || '').startsWith('tk:rate:')));
    await i.update({ components: [...rows, ratingRow(channelId, n)] }).catch(() => {});
    await i.followUp({ content: `Thanks for rating us ${STARS(n)}!`, flags: MessageFlags.Ephemeral }).catch(() => {});
    await updateLog(i.client, ticket, embed => setField(embed, 'Rating', `${STARS(n)} (${n}/5)`, true));
}

async function editReasonButton(i, channelId) {
    const ticket = await Tickets().findById(channelId).lean();
    if (!ticket) return ephemeral(i, 'That ticket record no longer exists.');
    if (!isStaff(i.member, PANELS[ticket.panel] || PANELS.robux)) return ephemeral(i, 'Only ticket staff can edit close reasons.');
    const input = new TextInputBuilder().setCustomId('reason').setLabel('Close reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    if (ticket.closeReason) input.setValue(ticket.closeReason.slice(0, 1000));
    return i.showModal(new ModalBuilder().setCustomId(`tk:editreasonmodal:${channelId}`).setTitle('Edit close reason').addComponents(new ActionRowBuilder().addComponents(input)));
}
async function editReasonSubmit(i, channelId) {
    const ticket = await Tickets().findById(channelId).lean();
    if (!ticket) return ephemeral(i, 'That ticket record no longer exists.');
    if (!isStaff(i.member, PANELS[ticket.panel] || PANELS.robux)) return ephemeral(i, 'Only ticket staff can edit close reasons.');
    const reason = i.fields.getTextInputValue('reason').trim();
    await Tickets().updateOne({ _id: channelId }, { $set: { closeReason: reason } });
    await updateLog(i.client, ticket, embed => setField(embed, 'Reason', `${reason.slice(0, 950)}\n*Edited by <@${i.user.id}>*`));
    return ephemeral(i, 'Close reason updated.');
}

// Close request: staff asks the opener to confirm; it closes on its own if there's no answer.
async function closeRequest(i, reason, hours) {
    const found = await ticketFor(i); if (!found) return;
    const { ticket, panel } = found;
    if (!isStaff(i.member, panel)) return ephemeral(i, 'Only ticket staff can request a close.');
    const delayH = Math.min(168, Math.max(1, Number(hours) || 24));
    const deadline = new Date(Date.now() + delayH * 3600_000);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk:cr:accept').setLabel('Close the ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tk:cr:deny').setLabel('Keep it open').setStyle(ButtonStyle.Secondary));
    const message = await i.channel.send({
        content: `<@${ticket.ownerId}>`,
        embeds: [{ title: 'Close Request', color: ORANGE, description: `<@${i.user.id}> would like to close this ticket.${reason ? `\n**Reason:** ${reason.slice(0, 1000)}` : ''}\n\nIf there's no reply, it closes automatically <t:${Math.floor(deadline.getTime() / 1000)}:R>.` }],
        components: [row], allowedMentions: { users: [ticket.ownerId] }
    });
    await Tickets().updateOne({ _id: i.channelId }, { $set: { closeRequest: { by: i.user.id, reason: reason || null, deadline, messageId: message.id } } });
    return ephemeral(i, `Close request sent. It closes automatically in ${delayH} hour${delayH === 1 ? '' : 's'} if there's no answer.`);
}
async function closeRequestAnswer(i, accept) {
    const found = await ticketFor(i); if (!found) return;
    const { ticket, panel } = found;
    if (!ticket.closeRequest) return ephemeral(i, 'There is no pending close request.');
    if (i.user.id !== ticket.ownerId && !isStaff(i.member, panel)) return ephemeral(i, 'Only the ticket opener can answer this.');
    if (accept) {
        await i.update({ components: [] }).catch(() => {});
        return closeTicket(i.channel, ticket, panel, i.user, ticket.closeRequest.reason || 'Close request accepted');
    }
    await Tickets().updateOne({ _id: i.channelId }, { $set: { closeRequest: null } });
    await i.update({ components: [], embeds: [{ ...(i.message.embeds[0]?.toJSON?.() || {}), title: 'Close Request Declined', color: GREEN, description: `<@${i.user.id}> wants to keep this ticket open.` }] }).catch(() => {});
}
async function expireCloseRequests(client) {
    if (!dbReady()) return;
    const due = await Tickets().find({ status: 'open', 'closeRequest.deadline': { $lte: new Date() } }).lean().catch(() => []);
    for (const ticket of due) {
        const channel = await client.channels.fetch(ticket._id).catch(() => null);
        if (!channel) continue;
        const requester = await client.users.fetch(ticket.closeRequest.by).catch(() => client.user);
        await closeTicket(channel, ticket, PANELS[ticket.panel] || PANELS.robux, requester, `${ticket.closeRequest.reason || 'Close request'} (no reply)`).catch(() => {});
    }
}

// Private staff-only thread inside the ticket. Running /notes again adds you to it.
async function notes(i) {
    const found = await ticketFor(i); if (!found) return;
    const { ticket, panel } = found;
    if (!isStaff(i.member, panel)) return ephemeral(i, 'Only ticket staff can use notes.');
    let thread = ticket.notesThreadId ? await i.channel.threads.fetch(ticket.notesThreadId).catch(() => null) : null;
    if (!thread) {
        thread = await i.channel.threads.create({ name: 'staff-notes', type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: 10080, reason: 'Staff notes' });
        await Tickets().updateOne({ _id: i.channelId }, { $set: { notesThreadId: thread.id } });
        await thread.send({ content: 'Private staff notes for this ticket. The buyer cannot see this thread, and it is not included in the transcript. Staff can join with `/notes`.', allowedMentions: { parse: [] } });
    }
    if (thread.archived) await thread.setArchived(false).catch(() => {});
    await thread.members.add(i.user.id).catch(() => {});
    return ephemeral(i, `Notes: <#${thread.id}>`);
}

async function blacklistAdd(i, user, reason) {
    await Blacklist().updateOne({ _id: user.id }, { $set: { guildId: i.guildId, reason: reason || null, by: i.user.id, at: new Date() } }, { upsert: true });
    return `<@${user.id}> can no longer open tickets.${reason ? ` Reason: ${reason}` : ''}`;
}
async function blacklistRemove(i, user) {
    await Blacklist().deleteOne({ _id: user.id });
    return `<@${user.id}> can open tickets again.`;
}
async function blacklistList() {
    const rows = await Blacklist().find({}).lean();
    return rows.length ? rows.map(r => `<@${r._id}>${r.reason ? ` · ${r.reason}` : ''} (by <@${r.by}>)`).join('\n') : 'Nobody is blacklisted.';
}

// ---------- events ----------
async function onMemberLeave(member) {
    if (!dbReady() || member.guild.id !== SETTINGS.guildId) return;
    const open = await Tickets().find({ guildId: member.guild.id, ownerId: member.id, status: 'open' }).lean().catch(() => []);
    for (const ticket of open) {
        const panel = PANELS[ticket.panel] || PANELS.robux;
        if (!panel.closeOnLeave) continue;
        const channel = await member.guild.channels.fetch(ticket._id).catch(() => null);
        if (channel) await closeTicket(channel, ticket, panel, member.client.user, 'Opener left the server').catch(() => {});
    }
}

async function onChannelDelete(channel) {
    if (!openChannels.has(channel.id)) return;
    openChannels.delete(channel.id);
    if (dbReady()) await Tickets().updateOne({ _id: channel.id, status: { $in: ['open', 'closing'] } }, { $set: { status: 'closed', closedAt: new Date(), closeReason: 'Channel deleted' } }).catch(() => {});
}

async function loadOpen(client) {
    if (!dbReady()) return;
    const open = await Tickets().find({ status: { $in: ['open', 'closing'] } }).lean();
    for (const ticket of open) {
        const guild = client.guilds.cache.get(ticket.guildId);
        const exists = guild?.channels.cache.has(ticket._id) || await guild?.channels.fetch(ticket._id).then(Boolean).catch(() => false);
        if (exists) {
            openChannels.add(ticket._id);
            // A restart mid-close leaves 'closing'; reopen so staff can close again.
            if (ticket.status === 'closing') await Tickets().updateOne({ _id: ticket._id }, { $set: { status: 'open' } });
        } else {
            await Tickets().updateOne({ _id: ticket._id }, { $set: { status: 'closed', closedAt: new Date(), closeReason: 'Channel missing' } });
        }
    }
    console.log(`[Tickets] Ready: ${openChannels.size} open DealDesk tickets.`);
}

// ---------- interaction router ----------
async function handleComponent(i) {
    try {
        const [, action, arg, arg2] = i.customId.split(':');
        if (action === 'rate' && i.isButton()) return await rate(i, arg, arg2);
        if (i.guildId !== SETTINGS.guildId) return ephemeral(i, 'Tickets are not enabled here.');
        if (action === 'editreason' && i.isButton()) return await editReasonButton(i, arg);
        if (action === 'editreasonmodal' && i.isModalSubmit()) return await editReasonSubmit(i, arg);
        if (action === 'cr' && i.isButton()) return await closeRequestAnswer(i, arg === 'accept');
        if (action === 'open' && i.isButton()) return await openFormFor(i, arg);
        if (action === 'form' && i.isModalSubmit()) return await createTicket(i, arg);
        if (action === 'claim' && i.isButton()) return await claim(i);
        if (action === 'close' && i.isButton()) return await closeButton(i, false);
        if (action === 'closereason' && i.isButton()) return await closeButton(i, true);
        if (action === 'closeconfirm' && i.isButton()) {
            const found = await ticketFor(i); if (!found) return;
            if (!canClose(i.member, found.ticket, found.panel, i.user.id)) return ephemeral(i, 'Only staff can close this ticket.');
            return await startClose(i, found.ticket, found.panel, null);
        }
        if (action === 'reasonmodal' && i.isModalSubmit()) {
            const found = await ticketFor(i); if (!found) return;
            if (!canClose(i.member, found.ticket, found.panel, i.user.id)) return ephemeral(i, 'Only staff can close this ticket.');
            return await startClose(i, found.ticket, found.panel, i.fields.getTextInputValue('reason'));
        }
        return ephemeral(i, 'This button is no longer active.');
    } catch (error) {
        console.error('[Tickets] Interaction failed:', error.code || error.message);
        return ephemeral(i, 'Something went wrong. Please try again.').catch(() => {});
    }
}

function install(client) {
    client.once(Events.ClientReady, () => {
        // Wait for index.js to connect to MongoDB.
        const start = Date.now();
        const timer = setInterval(() => {
            if (dbReady() || Date.now() - start > 120000) {
                clearInterval(timer);
                loadOpen(client).catch(error => console.error('[Tickets] Startup check failed:', error.message));
            }
        }, 2000);
    });
    setInterval(() => expireCloseRequests(client).catch(() => {}), 60_000);
    client.on(Events.GuildMemberRemove, member => { onMemberLeave(member).catch(() => {}); });
    client.on(Events.ChannelDelete, channel => { onChannelDelete(channel).catch(() => {}); });
}

module.exports = {
    install, installWeb: (app, client) => require('./TicketWeb').install(app, client), handleComponent,
    closeRequest, notes, blacklistAdd, blacklistRemove, blacklistList, rate, expireCloseRequests, Blacklist, categoryWithRoom, PANELS, isNative, postPanel, setDisabled, panelMessage, isDisabled,
    claim, unclaim, transfer, addUser, removeUser, rename, closeCommand, closeTicket,
    buildTranscript, channelName, fill, isStaff, Tickets, State, Transcripts, _openChannels: openChannels
};
