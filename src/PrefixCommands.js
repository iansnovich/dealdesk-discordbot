// Text-prefix commands: lets every slash command also run as ".command args",
// which is much easier to type on a phone. Each message is turned into an
// object that behaves like a ChatInputCommandInteraction, so commands run
// unchanged. Discord's own command permission rules (default member
// permissions + Server Settings > Integrations overrides) are enforced here,
// because text commands bypass Discord's slash-command filtering.
const { EventEmitter } = require('node:events');
const {
    ActionRowBuilder, ApplicationCommandOptionType: T, ButtonBuilder, ButtonStyle, ChannelType,
    EmbedBuilder, Events, MessageFlags, MessageFlagsBitField, PermissionFlagsBits, PermissionsBitField, Routes
} = require('discord.js');

const PREFIX = process.env.PREFIX || '.';
// How replies that a slash command would show "only to you" are delivered:
//  'button'  (default) a "Show reply" button only the caller can press; pressing it shows
//            the real ephemeral reply, exactly like the slash command, then the button is removed.
//  'dm'      sent to the caller's DMs.   'channel'  posted in the channel (not private).
const PRIVATE_REPLIES = (process.env.PREFIX_PRIVATE_REPLIES || 'button').toLowerCase();
const PRIVATE_BUTTON_MS = 10 * 60_000;
const HOME_GUILD = () => process.env.GUILD_ID || require('./config').guildId;
const COOLDOWN_MS = 3000;
const PERMISSION_REFRESH_MS = 5 * 60 * 1000;

const state = {
    loaded: false,
    globalCommands: new Map(), // name -> { id, contexts }
    guildCommands: new Map(), // name -> { id }
    overrides: new Map(), // commandId | applicationId -> [{ id, type, permission }]
    applicationId: null
};
const cooldowns = new Map();

// ---------------------------------------------------------------- parsing --

const TOKEN_RE = /([A-Za-z_][\w-]*)[:=](?:"([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|'([^']*)'|(\S+)/g;

function tokenize(text) {
    const tokens = [];
    for (const m of text.matchAll(TOKEN_RE)) {
        if (m[1] !== undefined) tokens.push({ key: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4], raw: m[0], quoted: m[2] !== undefined || m[3] !== undefined });
        else tokens.push({ key: null, value: m[5] ?? m[6] ?? m[7], raw: m[0], quoted: m[5] !== undefined || m[6] !== undefined });
    }
    return tokens;
}

const normalizeName = name => String(name || '').toLowerCase().replace(/[-_]/g, '');

function findCommand(client, name) {
    const wanted = normalizeName(name);
    if (!wanted) return null;
    for (const command of client.commands.values()) {
        if (normalizeName(command.data?.name) === wanted) return command;
    }
    return null;
}

const ID_RE = /^\d{17,20}$/;
const mentionId = (value, kind) => {
    const v = String(value).trim();
    const patterns = { user: /^<@!?(\d{17,20})>$/, channel: /^<#(\d{17,20})>$/, role: /^<@&(\d{17,20})>$/ };
    return v.match(patterns[kind])?.[1] || (ID_RE.test(v) ? v : null);
};

const TRUE_WORDS = new Set(['true', 'yes', 'y', 'on', '1', 'enable', 'enabled']);
const FALSE_WORDS = new Set(['false', 'no', 'n', 'off', '0', 'disable', 'disabled']);

function parseNumber(raw, integer) {
    const m = String(raw).trim().replace(/,/g, '').match(/^(-?\d+(?:\.\d+)?)([km])?$/i);
    if (!m) return null;
    let n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1);
    if (integer && !Number.isInteger(n)) return null;
    return n;
}

function pickChoice(option, raw) {
    if (!option.choices?.length) return { ok: true, value: raw };
    const lower = String(raw).toLowerCase();
    const hit = option.choices.find(c => String(c.value).toLowerCase() === lower || c.name.toLowerCase() === lower);
    return hit ? { ok: true, value: hit.value } : { ok: false, error: `\`${option.name}\` must be one of: ${option.choices.map(c => `\`${c.value}\``).join(', ')}` };
}

// Cheap synchronous check used to decide whether a positional token fits an
// optional non-string option (otherwise that option is skipped).
function looksLike(option, raw) {
    switch (option.type) {
        case T.User: return !!mentionId(raw, 'user') || /^@?\S{2,32}$/.test(raw);
        case T.Channel: return !!mentionId(raw, 'channel') || /^#\S+/.test(raw);
        case T.Role: return !!mentionId(raw, 'role') || /^@\S+/.test(raw);
        case T.Mentionable: return !!(mentionId(raw, 'user') || mentionId(raw, 'role'));
        case T.Integer: return parseNumber(raw, true) !== null;
        case T.Number: return parseNumber(raw, false) !== null;
        case T.Boolean: return TRUE_WORDS.has(raw.toLowerCase()) || FALSE_WORDS.has(raw.toLowerCase());
        case T.Attachment: return false;
        default: return true;
    }
}

// Splits the text after the command name into a subcommand + raw option values.
// A command can set `prefixOrder: ['user', 'community']` so typed values fill the
// options people expect first (slash commands are unaffected; names still work).
function prefixJson(command) {
    const json = command.data.toJSON();
    const order = command.prefixOrder;
    if (!Array.isArray(order) || !json.options?.length) return json;
    const rank = name => { const i = order.indexOf(name); return i < 0 ? order.length : i; };
    return { ...json, options: [...json.options].sort((a, b) => rank(a.name) - rank(b.name)) };
}

function bindArguments(commandJson, argText, attachments) {
    let tokens = tokenize(argText);
    let subcommand = null;
    let group = null;
    let options = commandJson.options || [];

    const subs = options.filter(o => o.type === T.Subcommand || o.type === T.SubcommandGroup);
    if (subs.length) {
        const first = tokens[0];
        const choose = list => list.find(o => first && !first.key && normalizeName(o.name) === normalizeName(first.value));
        let picked = choose(subs);
        if (!picked) return { error: 'missing-subcommand', subs };
        tokens = tokens.slice(1);
        if (picked.type === T.SubcommandGroup) {
            group = picked.name;
            const inner = picked.options || [];
            const next = tokens[0];
            picked = inner.find(o => next && !next.key && normalizeName(o.name) === normalizeName(next.value));
            if (!picked) return { error: 'missing-subcommand', subs: inner, group };
            tokens = tokens.slice(1);
        }
        subcommand = picked.name;
        options = picked.options || [];
    }

    const byName = new Map(options.map(o => [o.name.toLowerCase(), o]));
    const raw = new Map();
    const positional = [];
    for (const token of tokens) {
        if (token.key && byName.has(token.key)) raw.set(byName.get(token.key).name, token.value);
        else positional.push(token.key ? token.raw : token.value);
    }

    // Attachment options take the message's uploaded files in order.
    const files = [...attachments];
    for (const option of options) {
        if (option.type === T.Attachment && !raw.has(option.name) && files.length) raw.set(option.name, files.shift());
    }

    const open = options.filter(o => o.type !== T.Attachment && !raw.has(o.name));
    let i = 0;
    for (let k = 0; k < open.length && i < positional.length; k++) {
        const option = open[k];
        const remainingOpen = open.slice(k + 1).filter(o => o.type !== T.Attachment);
        if (option.type === T.String && remainingOpen.length === 0) {
            raw.set(option.name, positional.slice(i).join(' '));
            i = positional.length;
            break;
        }
        if (!option.required && option.type !== T.String && !looksLike(option, positional[i])) continue;
        // Free text doesn't belong in an optional "..._id" field.
        if (!option.required && option.type === T.String && /(^|_)id$/i.test(option.name) && !/^(<[@#][!&]?)?\d{17,20}>?$/.test(positional[i]) && remainingOpen.some(o => o.type === T.String)) continue;
        // A clear mention belongs to a later option of that kind, not an optional text field.
        const strong = /^(<#\d+>|#\S+)$/.test(positional[i]) ? [T.Channel] : /^<@&\d+>$/.test(positional[i]) ? [T.Role, T.Mentionable] : /^<@!?\d+>$/.test(positional[i]) ? [T.User, T.Mentionable] : /^@\S+$/.test(positional[i]) ? [T.User, T.Role, T.Mentionable] : null;
        if (strong && !option.required && !strong.includes(option.type) && remainingOpen.some(o => strong.includes(o.type))) continue;
        raw.set(option.name, positional[i++]);
    }
    if (i < positional.length) return { error: 'too-many', extra: positional.slice(i), options, subcommand, group };

    const missing = options.filter(o => o.required && !raw.has(o.name));
    if (missing.length) return { error: 'missing', missing, options, subcommand, group };
    return { subcommand, group, options, raw };
}

async function resolveUser(message, raw) {
    const id = mentionId(raw, 'user');
    if (id) {
        const user = await message.client.users.fetch(id).catch(() => null);
        return user ? { user, member: message.guild ? await message.guild.members.fetch(id).catch(() => null) : null } : null;
    }
    if (!message.guild) return null;
    const query = String(raw).replace(/^@/, '');
    const found = await message.guild.members.search({ query, limit: 10 }).catch(() => null);
    if (!found?.size) return null;
    const lower = query.toLowerCase();
    const exact = found.find(m => m.user.username.toLowerCase() === lower || m.displayName.toLowerCase() === lower || m.user.globalName?.toLowerCase() === lower);
    const member = exact || (found.size === 1 ? found.first() : null);
    return member ? { user: member.user, member } : null;
}

async function resolveChannel(message, raw, option) {
    const id = mentionId(raw, 'channel');
    let channel = null;
    if (id) channel = message.guild ? await message.guild.channels.fetch(id).catch(() => null) : await message.client.channels.fetch(id).catch(() => null);
    else if (message.guild) {
        const name = String(raw).replace(/^#/, '').toLowerCase();
        const all = await message.guild.channels.fetch().catch(() => message.guild.channels.cache);
        const matches = all.filter(c => c && c.name.toLowerCase() === name);
        channel = matches.size === 1 ? matches.first() : null;
    }
    if (!channel) return null;
    if (option.channel_types?.length && !option.channel_types.includes(channel.type)) return { wrongType: true };
    return channel;
}

async function resolveRole(message, raw) {
    if (!message.guild) return null;
    if (/^@?everyone$/i.test(raw)) return message.guild.roles.everyone;
    const id = mentionId(raw, 'role');
    if (id) return message.guild.roles.fetch(id).catch(() => null);
    const name = String(raw).replace(/^@/, '').toLowerCase();
    const matches = message.guild.roles.cache.filter(r => r.name.toLowerCase() === name);
    return matches.size === 1 ? matches.first() : null;
}

async function resolveOptions(message, bound) {
    const data = [];
    for (const option of bound.options) {
        if (!bound.raw.has(option.name)) continue;
        const raw = bound.raw.get(option.name);
        const entry = { name: option.name, type: option.type, value: raw };
        switch (option.type) {
            case T.String: {
                const choice = pickChoice(option, raw);
                if (!choice.ok) return { error: choice.error };
                entry.value = String(choice.value);
                if (option.min_length && entry.value.length < option.min_length) return { error: `\`${option.name}\` must be at least ${option.min_length} characters.` };
                if (option.max_length && entry.value.length > option.max_length) return { error: `\`${option.name}\` must be at most ${option.max_length} characters.` };
                break;
            }
            case T.Integer:
            case T.Number: {
                const choice = pickChoice(option, raw);
                const n = choice.ok && option.choices?.length ? Number(choice.value) : parseNumber(raw, option.type === T.Integer);
                if (!choice.ok) return { error: choice.error };
                if (n === null || Number.isNaN(n)) return { error: `\`${option.name}\` must be ${option.type === T.Integer ? 'a whole number' : 'a number'}.` };
                if (option.min_value !== undefined && n < option.min_value) return { error: `\`${option.name}\` must be at least ${option.min_value}.` };
                if (option.max_value !== undefined && n > option.max_value) return { error: `\`${option.name}\` must be at most ${option.max_value}.` };
                entry.value = n;
                break;
            }
            case T.Boolean: {
                const v = String(raw).toLowerCase();
                if (!TRUE_WORDS.has(v) && !FALSE_WORDS.has(v)) return { error: `\`${option.name}\` must be yes or no.` };
                entry.value = TRUE_WORDS.has(v);
                break;
            }
            case T.User: {
                const found = await resolveUser(message, raw);
                if (!found) return { error: `Couldn't find a user for \`${raw}\`. Use a mention or their user ID.` };
                entry.value = found.user.id; entry.user = found.user; if (found.member) entry.member = found.member;
                break;
            }
            case T.Channel: {
                const channel = await resolveChannel(message, raw, option);
                if (!channel) return { error: `Couldn't find a channel for \`${raw}\`. Use #channel or its ID.` };
                if (channel.wrongType) return { error: `\`${raw}\` is the wrong kind of channel for \`${option.name}\`.` };
                entry.value = channel.id; entry.channel = channel;
                break;
            }
            case T.Role: {
                const role = await resolveRole(message, raw);
                if (!role) return { error: `Couldn't find a role for \`${raw}\`. Use @role or its ID.` };
                entry.value = role.id; entry.role = role;
                break;
            }
            case T.Mentionable: {
                const role = mentionId(raw, 'role') ? await resolveRole(message, raw) : null;
                const found = role ? null : await resolveUser(message, raw);
                if (!role && !found) return { error: `Couldn't find a user or role for \`${raw}\`.` };
                if (role) { entry.value = role.id; entry.role = role; } else { entry.value = found.user.id; entry.user = found.user; if (found.member) entry.member = found.member; }
                break;
            }
            case T.Attachment: {
                if (typeof raw === 'string') return { error: `Attach a file to the message for \`${option.name}\`.` };
                entry.value = raw.id; entry.attachment = raw;
                break;
            }
        }
        data.push(entry);
    }
    return { data };
}

class PrefixOptions {
    constructor(subcommand, group, data) {
        this._subcommand = subcommand;
        this._group = group;
        this._hoistedOptions = data;
        this.data = subcommand
            ? [group ? { name: group, type: T.SubcommandGroup, options: [{ name: subcommand, type: T.Subcommand, options: data }] } : { name: subcommand, type: T.Subcommand, options: data }]
            : data;
    }
    get(name, required = false) {
        const option = this._hoistedOptions.find(o => o.name === name);
        if (!option && required) throw new TypeError(`Required option "${name}" not found.`);
        return option || null;
    }
    _typed(name, types, prop, required) {
        const option = this.get(name, required);
        if (!option) return null;
        if (!types.includes(option.type)) throw new TypeError(`Option "${name}" is of type ${option.type}; expected ${types.join('/')}.`);
        return prop in option ? option[prop] : null;
    }
    getSubcommand(required = true) {
        if (required && !this._subcommand) throw new TypeError('A subcommand was not selected.');
        return this._subcommand;
    }
    getSubcommandGroup(required = false) {
        if (required && !this._group) throw new TypeError('A subcommand group was not selected.');
        return this._group;
    }
    getString(n, r = false) { return this._typed(n, [T.String], 'value', r); }
    getInteger(n, r = false) { return this._typed(n, [T.Integer], 'value', r); }
    getNumber(n, r = false) { return this._typed(n, [T.Number], 'value', r); }
    getBoolean(n, r = false) { return this._typed(n, [T.Boolean], 'value', r); }
    getUser(n, r = false) { return this._typed(n, [T.User, T.Mentionable], 'user', r); }
    getMember(n) { return this.get(n)?.member ?? null; }
    getChannel(n, r = false) { return this._typed(n, [T.Channel], 'channel', r); }
    getRole(n, r = false) { return this._typed(n, [T.Role, T.Mentionable], 'role', r); }
    getAttachment(n, r = false) { return this._typed(n, [T.Attachment], 'attachment', r); }
    getMentionable(n, r = false) { const o = this.get(n, r); return o ? (o.member ?? o.user ?? o.role ?? null) : null; }
    getFocused() { throw new TypeError('getFocused is only available for autocomplete.'); }
}

// -------------------------------------------------------- reply emulation --

function isEphemeral(options) {
    if (!options || typeof options !== 'object') return false;
    if (options.ephemeral) return true;
    if (options.flags === undefined || options.flags === null) return false;
    try { return new MessageFlagsBitField(options.flags).has(MessageFlags.Ephemeral); } catch { return false; }
}

function toMessagePayload(options, forEdit = false) {
    if (typeof options === 'string') return { content: options };
    const payload = { ...options };
    delete payload.ephemeral; delete payload.fetchReply; delete payload.withResponse;
    if (payload.flags !== undefined && payload.flags !== null) {
        try {
            const flags = new MessageFlagsBitField(payload.flags).remove(MessageFlags.Ephemeral);
            if (flags.bitfield) payload.flags = flags.bitfield; else delete payload.flags;
        } catch { delete payload.flags; }
    }
    if (forEdit) delete payload.message;
    return payload;
}

function alreadyReplied() {
    const error = new Error('The reply to this interaction has already been sent or deferred.');
    error.code = 'InteractionAlreadyReplied';
    return error;
}
function notReplied() {
    const error = new Error('The reply to this interaction has not been sent or deferred.');
    error.code = 'InteractionNotReplied';
    return error;
}

// Collector handed out before a private reply has been opened; it attaches to
// the real ephemeral message once the caller presses "Show reply".
class RelayCollector extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.ended = false;
        this.real = null;
        this.started = Date.now();
        if (options.time) this.timer = setTimeout(() => this.stop('time'), options.time);
    }
    attach(message) {
        if (this.ended) return;
        const remaining = this.options.time ? Math.max(1000, this.options.time - (Date.now() - this.started)) : undefined;
        clearTimeout(this.timer);
        this.real = message.createMessageComponentCollector({ ...this.options, ...(remaining ? { time: remaining } : {}) });
        for (const event of ['collect', 'ignore', 'dispose']) this.real.on(event, (...args) => this.emit(event, ...args));
        this.real.on('end', (...args) => { this.ended = true; this.emit('end', ...args); });
    }
    stop(reason = 'user') {
        if (this.real) return this.real.stop(reason);
        if (this.ended) return;
        this.ended = true;
        clearTimeout(this.timer);
        this.emit('end', new Map(), reason);
    }
}

// Stands in for an ephemeral reply: a small "Show reply" button only the caller
// can press. Pressing it answers with the real ephemeral message (latest content),
// and later edits/collectors go to that message, just like a slash command.
class PrivateReply {
    static async create(interaction, payload) {
        const reply = new PrivateReply(interaction, payload);
        await reply.post();
        return reply;
    }
    constructor(interaction, payload) {
        this.interaction = interaction;
        this.payload = payload;
        this.button = null;     // the button interaction once opened
        this.message = null;    // the real ephemeral message once opened
        this.pending = [];      // collectors waiting for the open
        this.stub = null;
        this.id = null;
    }
    async post() {
        const customId = `prefix_private:${this.interaction.id}:${Math.random().toString(36).slice(2, 8)}`;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId).setLabel('Show reply').setEmoji('🔒').setStyle(ButtonStyle.Primary));
        this.stub = await this.interaction._sendInChannel({ content: `<@${this.interaction.user.id}> your reply is ready. Only you can open it.`, components: [row], allowedMentions: { parse: [], users: [this.interaction.user.id] } });
        this.id = this.stub.id;
        this.url = this.stub.url;
        const collector = this.stub.createMessageComponentCollector({ time: PRIVATE_BUTTON_MS, filter: b => b.customId === customId });
        collector.on('collect', async button => {
            if (button.user.id !== this.interaction.user.id) {
                return button.reply({ content: 'This reply belongs to someone else.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            if (this.button) return button.reply({ content: 'You already opened this reply above.', flags: MessageFlags.Ephemeral }).catch(() => {});
            this.button = button;
            try {
                await button.reply({ ...this.payload, flags: MessageFlags.Ephemeral });
                this.message = await button.fetchReply();
                for (const relay of this.pending) relay.attach(this.message);
                this.pending = [];
            } catch (error) {
                console.error('[Prefix] Private reply failed:', error.message);
            }
            collector.stop('opened');
        });
        collector.on('end', (_c, reason) => {
            if (reason === 'opened') return this.stub.delete().catch(() => {});
            this.stub.edit({ content: `<@${this.interaction.user.id}> this private reply expired. Run the command again to see it.`, components: [] }).catch(() => {});
            for (const relay of this.pending) relay.stop('time');
        });
    }
    async edit(options) {
        const payload = toMessagePayload(options, true);
        if (this.button) { await this.button.editReply(payload); return this; }
        this.payload = { ...this.payload, ...payload };
        return this;
    }
    async delete() {
        if (this.button) return this.button.deleteReply().catch(() => {});
        return this.stub?.delete().catch(() => {});
    }
    createMessageComponentCollector(options) {
        const relay = new RelayCollector(options);
        if (this.message) relay.attach(this.message); else this.pending.push(relay);
        return relay;
    }
    awaitMessageComponent(options = {}) {
        return new Promise((resolve, reject) => {
            const relay = this.createMessageComponentCollector({ ...options, max: 1 });
            relay.once('collect', resolve);
            relay.once('end', (collected, reason) => { if (!collected?.size) reject(Object.assign(new Error(`Collector ended: ${reason}`), { code: 'InteractionCollectorError' })); });
        });
    }
}

class PrefixInteraction {
    constructor(message, command, bound, data) {
        this.message_ = message;
        this.client = message.client;
        this.id = message.id;
        this.applicationId = message.client.application?.id ?? null;
        this.type = 2;
        this.commandType = 1;
        this.commandName = command.data.name;
        this.commandId = state.globalCommands.get(command.data.name)?.id || state.guildCommands.get(command.data.name)?.id || null;
        this.commandGuildId = state.guildCommands.has(command.data.name) ? message.guildId : null;
        this.user = message.author;
        this.member = message.member ?? null;
        this.guild = message.guild ?? null;
        this.guildId = message.guildId ?? null;
        this.channel = message.channel;
        this.channelId = message.channelId;
        this.createdTimestamp = message.createdTimestamp;
        this.locale = 'en-US';
        this.guildLocale = message.guild?.preferredLocale ?? null;
        this.context = message.guild ? 0 : 1;
        // Text commands come through the guild-installed bot, both in the server and in its DMs.
        this.authorizingIntegrationOwners = { 0: message.guildId ?? '0' };
        this.memberPermissions = message.member && message.channel?.permissionsFor ? message.channel.permissionsFor(message.member) : null;
        this.appPermissions = message.guild?.members.me && message.channel?.permissionsFor ? message.channel.permissionsFor(message.guild.members.me) : null;
        this.options = new PrefixOptions(bound.subcommand, bound.group, data);
        this.deferred = false;
        this.replied = false;
        this.ephemeral = null;
        this.isPrefixCommand = true;
        this._reply = null; // the message standing in for the original response
        this._followUps = new Map();
        this._dmNoticeSent = false;
        this._modalHost = null;
    }

    get createdAt() { return new Date(this.createdTimestamp); }
    isChatInputCommand() { return true; }
    isCommand() { return true; }
    isRepliable() { return true; }
    inGuild() { return Boolean(this.guildId); }
    inCachedGuild() { return Boolean(this.guild); }
    inRawGuild() { return false; }

    async _send(options, ephemeral) {
        const payload = toMessagePayload(options);
        if (ephemeral && this.guild && PRIVATE_REPLIES === 'button') return PrivateReply.create(this, payload);
        if (ephemeral && this.guild && PRIVATE_REPLIES === 'dm') {
            try {
                const sent = await this.user.send(payload);
                if (!this._dmNoticeSent) {
                    this._dmNoticeSent = true;
                    await this.message_.react('📬').catch(() => {});
                }
                return sent;
            } catch {
                // DMs closed: fall back to the channel and tidy up shortly after.
                const sent = await this._sendInChannel({ ...payload, content: [`<@${this.user.id}> (your DMs are closed, so this message will delete itself in 60s)`, payload.content].filter(Boolean).join('\n') });
                setTimeout(() => sent.delete().catch(() => {}), 60_000);
                return sent;
            }
        }
        return this._sendInChannel(payload);
    }

    _sendInChannel(payload) {
        return this.channel.send({
            ...payload,
            allowedMentions: { parse: ['users', 'roles', 'everyone'], ...(payload.allowedMentions || {}), repliedUser: false },
            reply: { messageReference: this.message_.id, failIfNotExists: false }
        });
    }

    _wrap(message, options) {
        if (options && typeof options === 'object' && options.withResponse) {
            return { interaction: { id: this.id, type: this.type, responseMessageId: message.id }, resource: { type: 4, message } };
        }
        return message;
    }

    async reply(options) {
        if (this.deferred || this.replied) throw alreadyReplied();
        this.ephemeral = isEphemeral(options);
        this.replied = true;
        this._reply = await this._send(options, this.ephemeral);
        return this._wrap(this._reply, options);
    }

    async deferReply(options = {}) {
        if (this.deferred || this.replied) throw alreadyReplied();
        this.ephemeral = isEphemeral(options);
        this.deferred = true;
        if (!this.ephemeral) await this.channel.sendTyping?.().catch(() => {});
        return options.withResponse ? { interaction: { id: this.id, type: this.type }, resource: { type: 5, message: null } } : undefined;
    }

    async editReply(options) {
        if (!this.deferred && !this.replied) throw notReplied();
        const target = typeof options === 'object' && options?.message && options.message !== '@original'
            ? this._followUps.get(typeof options.message === 'string' ? options.message : options.message.id)
            : null;
        if (target) return target.edit(toMessagePayload(options, true));
        if (!this._reply) {
            this.replied = true;
            this._reply = await this._send(toMessagePayload(options, true), this.ephemeral);
            return this._reply;
        }
        this.replied = true;
        this._reply = await this._reply.edit(toMessagePayload(options, true));
        return this._reply;
    }

    async fetchReply(id = '@original') {
        if (id !== '@original') return this._followUps.get(id) ?? null;
        if (!this._reply) {
            if (!this.deferred && !this.replied) throw notReplied();
            this._reply = await this._send({ content: '⏳ Working…' }, this.ephemeral);
        }
        return this._reply;
    }

    async deleteReply(id = '@original') {
        const target = id === '@original' ? this._reply : this._followUps.get(typeof id === 'string' ? id : id.id);
        if (target) await target.delete().catch(() => {});
    }

    async followUp(options) {
        if (!this.deferred && !this.replied) throw notReplied();
        const sent = await this._send(options, isEphemeral(options));
        this._followUps.set(sent.id, sent);
        return sent;
    }

    async update() { throw new Error('update() is only available for component interactions.'); }
    async deferUpdate() { throw new Error('deferUpdate() is only available for component interactions.'); }
    async respond() { throw new Error('respond() is only available for autocomplete.'); }

    // Forms and Activities need a real interaction, so post a button that
    // opens them; the tap is a genuine interaction Discord accepts.
    async _launchButton(label, emoji) {
        if (this.deferred || this.replied) throw alreadyReplied();
        this.replied = true;
        const customId = `prefix_launch:${this.id}`;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Primary));
        const message = await this._sendInChannel({ content: `<@${this.user.id}> tap the button to continue.`, components: [row] });
        this._reply = message;
        const collector = message.createMessageComponentCollector({ time: 10 * 60_000, filter: b => b.customId === customId && b.user.id === this.user.id });
        collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
        return collector;
    }

    async showModal(modal) {
        const collector = await this._launchButton('Open form', '📝');
        let resolveFirst;
        this._modalHost = new Promise(resolve => { resolveFirst = resolve; });
        collector.on('collect', button => {
            // Re-tapping reopens the form if it was dismissed.
            button.showModal(modal).then(() => resolveFirst(button)).catch(error => console.error('[Prefix] showModal failed:', error));
        });
        return undefined;
    }

    async awaitModalSubmit(options) {
        if (!this._modalHost) throw new Error('No form was shown for this command.');
        const button = await this._modalHost;
        return button.awaitModalSubmit(options);
    }

    async launchActivity(options) {
        const collector = await this._launchButton('Launch activity', '▶️');
        const button = await new Promise((resolve, reject) => {
            collector.once('collect', resolve);
            collector.once('end', (_c, reason) => { if (reason !== 'launched') reject(Object.assign(new Error('The button was not used in time.'), { code: 'InteractionCollectorError' })); });
        });
        collector.stop('launched');
        return button.launchActivity(options);
    }
}

// ------------------------------------------------------------ permissions --

async function loadCommandState(client) {
    const guildId = HOME_GUILD();
    const app = client.application?.id ? client.application : await client.application.fetch();
    state.applicationId = app.id;
    const globals = await client.application.commands.fetch();
    state.globalCommands = new Map(globals.map(c => [c.name, { id: c.id, contexts: c.contexts ?? null }]));
    const guildCommands = await client.application.commands.fetch({ guildId });
    state.guildCommands = new Map(guildCommands.map(c => [c.name, { id: c.id }]));
    const permissions = await client.rest.get(Routes.guildApplicationCommandsPermissions(app.id, guildId));
    state.overrides = new Map(permissions.map(entry => [entry.id, entry.permissions]));
    state.loaded = true;
    console.log(`[Prefix] Text commands ready with prefix "${PREFIX}": ${state.guildCommands.size} server + ${state.globalCommands.size} global commands, ${permissions.length} permission override set(s).`);
}

// Mirrors Discord's evaluation: admins always pass. Each check looks at the
// command's own overrides first, then the app-wide ones ("all commands"):
// channel: this channel (or a thread's parent) > all channels;
// member: user > roles (any allow wins) > @everyone;
// with no matching member override the command's default_member_permissions applies.
function canUse(member, channel, commandId, defaultMemberPermissions) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return { ok: true };
    const guildId = member.guild.id;
    const levels = [state.overrides.get(commandId) || [], state.overrides.get(state.applicationId) || []];

    const channelId = channel.isThread?.() ? channel.parentId : channel.id;
    const allChannels = (BigInt(guildId) - 1n).toString();
    for (const list of levels) {
        const rule = list.find(o => o.type === 3 && o.id === channelId) || list.find(o => o.type === 3 && o.id === allChannels);
        if (rule) {
            if (!rule.permission) return { ok: false, reason: 'That command is turned off in this channel.' };
            break;
        }
    }

    for (const list of levels) {
        const userRule = list.find(o => o.type === 2 && o.id === member.id);
        if (userRule) return { ok: userRule.permission };
        const roleRules = list.filter(o => o.type === 1 && o.id !== guildId && member.roles.cache.has(o.id));
        if (roleRules.length) return { ok: roleRules.some(o => o.permission) };
        const everyoneRule = list.find(o => o.type === 1 && o.id === guildId);
        if (everyoneRule) return { ok: everyoneRule.permission };
    }

    if (defaultMemberPermissions === null || defaultMemberPermissions === undefined) return { ok: true };
    const required = BigInt(defaultMemberPermissions);
    if (required === 0n) return { ok: false };
    return { ok: member.permissions.has(new PermissionsBitField(required)) };
}

// Which commands can this person run here?  Returns { ok, reason }.
function availability(message, command, json) {
    const name = command.data.name;
    if (!message.guild) {
        const global = state.globalCommands.get(name);
        if (!global) return { ok: false, reason: 'That command only works in the server.' };
        if (global.contexts && !global.contexts.includes(1)) return { ok: false, reason: 'That command only works in the server.' };
        return { ok: true };
    }
    const isHome = message.guild.id === HOME_GUILD();
    const id = state.guildCommands.get(name)?.id && isHome ? state.guildCommands.get(name).id : state.globalCommands.get(name)?.id;
    if (!id) return { ok: false, silent: true };
    if (!isHome) {
        // Outside the home server only global commands exist; no override data is loaded for it.
        const required = json.default_member_permissions;
        if (required === undefined || required === null || message.member.permissions.has(PermissionFlagsBits.Administrator)) return { ok: true };
        return BigInt(required) !== 0n && message.member.permissions.has(new PermissionsBitField(BigInt(required))) ? { ok: true } : { ok: false };
    }
    return canUse(message.member, message.channel, id, json.default_member_permissions);
}

// ------------------------------------------------------------------- help --

function optionUsage(option) {
    const kind = { [T.String]: 'text', [T.Integer]: 'number', [T.Number]: 'number', [T.Boolean]: 'yes/no', [T.User]: '@user', [T.Channel]: '#channel', [T.Role]: '@role', [T.Mentionable]: '@user/@role', [T.Attachment]: 'attach file' }[option.type] || 'value';
    return option.required ? `<${option.name}: ${kind}>` : `[${option.name}:${kind}]`;
}

function usageLines(json) {
    const lines = [];
    const describe = (path, options = [], description) => {
        const args = options.map(optionUsage).join(' ');
        lines.push(`\`${PREFIX}${path}${args ? ' ' + args : ''}\`${description ? ` — ${description}` : ''}`);
    };
    const subs = (json.options || []).filter(o => o.type === T.Subcommand || o.type === T.SubcommandGroup);
    if (!subs.length) describe(json.name, json.options, json.description);
    for (const sub of subs) {
        if (sub.type === T.SubcommandGroup) for (const inner of sub.options || []) describe(`${json.name} ${sub.name} ${inner.name}`, inner.options, inner.description);
        else describe(`${json.name} ${sub.name}`, sub.options, sub.description);
    }
    return lines;
}

// ---- help cards (shown for typos and wrong arguments, and by .help <command>)
function exampleValue(option) {
    const n = option.name.toLowerCase();
    if (option.choices?.length) return String(option.choices[0].value);
    if (option.type === T.User || option.type === T.Mentionable) return '@user';
    if (option.type === T.Channel) return '#channel';
    if (option.type === T.Role) return '@role';
    if (option.type === T.Boolean) return 'true';
    if (option.type === T.Integer || option.type === T.Number) return /rate|percent/.test(n) ? '5' : /hour/.test(n) ? '24' : /next|number/.test(n) ? '6200' : '1000';
    if (/roblox|^user$|username|recipient/.test(n)) return 'RobloxUsername';
    if (/amount/.test(n)) return '1000';
    if (/reason|note|message|text|description|issue/.test(n)) return '"your text here"';
    if (/community|group|link/.test(n)) return 'https://www.roblox.com/communities/123456';
    if (/(^|_)id$/.test(n)) return '123456789012345678';
    return 'value';
}
function examples(command, json) {
    if (Array.isArray(command?.prefixExamples) && command.prefixExamples.length) return command.prefixExamples.slice(0, 4);
    const out = [];
    const build = (path, options = []) => {
        const usable = options.filter(o => o.type !== T.Attachment);
        const required = usable.filter(o => o.required);
        const shown = required.length ? required : usable.slice(0, 1);
        const value = o => exampleValue(o);
        out.push([
            `${PREFIX}${path}${shown.length ? ' ' + shown.map(value).join(' ') : ''}`,
            `/${path}${shown.length ? ' ' + shown.map(o => `${o.name}:${value(o).replace(/^"|"$/g, '')}`).join(' ') : ''}`
        ]);
    };
    const subs = (json.options || []).filter(o => o.type === T.Subcommand || o.type === T.SubcommandGroup);
    if (!subs.length) build(json.name, json.options);
    for (const sub of subs) {
        if (sub.type === T.SubcommandGroup) for (const inner of sub.options || []) build(`${json.name} ${sub.name} ${inner.name}`, inner.options);
        else build(`${json.name} ${sub.name}`, sub.options);
    }
    return out.slice(0, 4);
}
function helpCard(command, json, problem) {
    const lines = [];
    if (problem) lines.push(`**${problem}**`, '');
    lines.push(json.description || '', '', '**How to use**', ...usageLines(json).slice(0, 12), '', '**Examples**');
    for (const [dot, slash] of examples(command, json)) lines.push(`\`${dot}\`${slash ? `  or  \`${slash}\`` : ''}`);
    lines.push('', '`<…>` is required, `[name:…]` is optional. Values work in order, or as `name:value`. Wrap text with spaces in "quotes".');
    return new EmbedBuilder().setTitle(`${PREFIX}${json.name}`).setDescription(lines.join('\n').slice(0, 4000));
}
// Edit distance where swapping two neighbouring letters counts as one typo.
const editDistance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
};
// Closest command this person can use, for typos like ".payoutchekc".
function suggestCommand(message, name) {
    const wanted = normalizeName(name);
    if (!/^[a-z][a-z0-9]{2,31}$/.test(wanted)) return null;
    let best = null, bestScore = Infinity;
    for (const command of message.client.commands.values()) {
        const json = command.data?.toJSON?.();
        if (!json || !availability(message, command, json).ok) continue;
        const target = normalizeName(json.name);
        const score = target.startsWith(wanted) && wanted.length >= 4 ? 0.5 : editDistance(wanted, target);
        if (score < bestScore) { best = command; bestScore = score; }
    }
    const limit = wanted.length <= 5 ? 1 : 2;
    return bestScore <= limit ? best : null;
}

async function sendHelp(message, query) {
    const reply = payload => message.channel.send({ ...payload, reply: { messageReference: message.id, failIfNotExists: false }, allowedMentions: { repliedUser: false } });
    if (query) {
        const command = findCommand(message.client, query);
        const json = command?.data?.toJSON ? prefixJson(command) : null;
        if (!command || !json || !availability(message, command, json).ok) return reply({ content: `No command called \`${query}\` that you can use here.` });
        return reply({ embeds: [helpCard(command, json)] });
    }
    const names = [];
    for (const command of message.client.commands.values()) {
        const json = command.data?.toJSON?.();
        if (json && availability(message, command, json).ok) names.push(json.name);
    }
    names.sort();
    const embed = new EmbedBuilder()
        .setTitle('Text commands')
        .setDescription([
            `Every slash command also works as a message starting with \`${PREFIX}\`, which is easier on a phone.`,
            `Options go after the name, in order or as \`name:value\`, e.g. \`${PREFIX}command @user 500 note:"text with spaces"\``,
            `Type \`${PREFIX}help <command>\` to see a command's options.`,
            '',
            names.map(n => `\`${PREFIX}${n}\``).join('  ')
        ].join('\n').slice(0, 4000));
    return reply({ embeds: [embed] });
}

// ---------------------------------------------------------------- runtime --

async function handleMessage(message) {
    if (message.author.bot || message.webhookId || !message.content) return;
    const me = message.client.user;
    let body = null;
    if (message.content.startsWith(PREFIX)) body = message.content.slice(PREFIX.length);
    else {
        const mention = message.content.match(new RegExp(`^<@!?${me.id}>\\s*`));
        if (mention) body = message.content.slice(mention[0].length);
    }
    if (body === null || /^\s/.test(body) || !body.trim()) return;

    const [, name = '', argText = ''] = body.match(/^(\S+)\s*([\s\S]*)$/) || [];
    if (normalizeName(name) === 'help' || normalizeName(name) === 'commands') {
        if (!state.loaded) return;
        return sendHelp(message, argText.trim().split(/\s+/)[0] || null).catch(error => console.error('[Prefix] help failed:', error));
    }

    const command = findCommand(message.client, name);
    if (!command || typeof command.execute !== 'function') {
        // A close typo of a real command gets a help card; anything else stays quiet.
        if (!state.loaded || !message.guild || !message.member) return;
        const guess = suggestCommand(message, name);
        if (!guess) return;
        const guessJson = prefixJson(guess);
        return message.channel.send({ embeds: [helpCard(guess, guessJson, `There's no \`${PREFIX}${name.slice(0, 32)}\` command. Did you mean \`${PREFIX}${guessJson.name}\`?`)], reply: { messageReference: message.id, failIfNotExists: false }, allowedMentions: { repliedUser: false, parse: [] } }).catch(() => {});
    }
    if (message.guild && !message.member) await message.guild.members.fetch(message.author.id).catch(() => null);
    if (message.guild && !message.member) return;
    const json = prefixJson(command);
    const say = content => message.channel.send({ content, reply: { messageReference: message.id, failIfNotExists: false }, allowedMentions: { repliedUser: false, parse: [] } }).catch(() => {});
    const card = problem => message.channel.send({ embeds: [helpCard(command, json, problem)], reply: { messageReference: message.id, failIfNotExists: false }, allowedMentions: { repliedUser: false, parse: [] } }).catch(() => {});

    if (!state.loaded) {
        if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return say('Text commands are still starting up. Try again in a moment.');
    } else {
        const access = availability(message, command, json);
        if (!access.ok) return access.silent ? undefined : say(access.reason || 'You don’t have permission to use that command.');
    }

    const key = `${message.author.id}-${json.name}`;
    const last = cooldowns.get(key);
    if (last && Date.now() - last < COOLDOWN_MS) return say(`⏱️ Slow down! Wait ${((COOLDOWN_MS - (Date.now() - last)) / 1000).toFixed(1)}s before using \`${PREFIX}${json.name}\` again.`);
    cooldowns.set(key, Date.now());
    setTimeout(() => cooldowns.delete(key), COOLDOWN_MS);

    const bound = bindArguments(json, argText, message.attachments.values());
    if (bound.error) {
        if (bound.error === 'missing-subcommand') return card(`Pick one of: ${bound.subs.map(s => `\`${s.name}\``).join(', ')}`);
        if (bound.error === 'missing') return card(`Missing ${bound.missing.map(o => `\`${o.name}\``).join(', ')}.`);
        if (bound.error === 'too-many') return card(`I didn't understand \`${bound.extra.join(' ').slice(0, 100)}\`.`);
    }
    const resolved = await resolveOptions(message, bound);
    if (resolved.error) return card(resolved.error);

    const interaction = new PrefixInteraction(message, command, bound, resolved.data);
    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(`[Prefix] Error executing ${json.name}:`, error);
        const content = '❌ An error occurred while executing this command.';
        if (interaction.deferred && !interaction._reply) await interaction.editReply({ content }).catch(() => {});
        else await say(content);
    }
}

function install(client) {
    const refresh = () => loadCommandState(client).catch(error => console.error('[Prefix] Could not load command permissions:', error.message || error));
    const start = () => {
        // index.js re-deploys commands on startup; read them after that settles.
        setTimeout(refresh, 20_000);
        setTimeout(refresh, 90_000); // again once index.js has finished re-registering commands
        setInterval(refresh, PERMISSION_REFRESH_MS);
    };
    if (client.isReady()) start(); else client.once(Events.ClientReady, start);
    client.on('applicationCommandPermissionsUpdate', () => { void refresh(); });
    client.on('messageCreate', message => { handleMessage(message).catch(error => console.error('[Prefix] Message handling failed:', error)); });
}

module.exports = { install, PREFIX, tokenize, bindArguments, prefixJson, helpCard, examples, suggestCommand, editDistance, canUse, PrefixInteraction, PrefixOptions, PrivateReply, RelayCollector, _state: state };
