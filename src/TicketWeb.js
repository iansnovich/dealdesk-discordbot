// Web side of DealDesk tickets, served behind a reverse proxy (e.g. a
// Cloudflare Worker) that forwards requests with the gateway key header:
//   /transcript/<token>     transcript, only for the ticket opener and staff
//   /tickets                staff dashboard: search tickets, open transcripts, toggle panels
//   /tickets/auth/*         "Sign in with Discord" (identify scope only)
// Sessions are a signed cookie (7 days); nothing else is stored in the browser.
const crypto = require('node:crypto');
const { PermissionFlagsBits: P } = require('discord.js');

const SESSION_COOKIE = 'dd_session';
const SESSION_MS = 7 * 24 * 3600_000;
const states = new Map(); // oauth state -> { next, exp }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tickets = () => require('./Tickets');
const verify = () => require('./WebGateway');

function settings(client) {
    const secret = process.env.DISCORD_OAUTH_CLIENT_SECRET || process.env.DISCORD_ACTIVITY_CLIENT_SECRET || '';
    const base = String(verify().PUBLIC_URL || '').replace(/\/$/, '');
    return {
        clientId: process.env.DISCORD_OAUTH_CLIENT_ID || process.env.CLIENT_ID || process.env.clientId || client.user?.id,
        secret,
        base,
        redirectUri: `${base}/tickets/auth/callback`,
        key: crypto.createHash('sha256').update(`dealdesk-ticket-session:${secret || process.env.GATEWAY_KEY || 'unset'}`).digest()
    };
}

const sign = (key, value) => crypto.createHmac('sha256', key).update(value).digest('base64url');
function makeSession(key, userId) {
    const body = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + SESSION_MS })).toString('base64url');
    return `${body}.${sign(key, body)}`;
}
function readSession(key, req) {
    const raw = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(SESSION_COOKIE + '='));
    if (!raw) return null;
    const [body, mac] = raw.slice(SESSION_COOKIE.length + 1).split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(sign(key, body)), got = Buffer.from(mac);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString());
        return data.e > Date.now() && /^\d{17,20}$/.test(data.u) ? data.u : null;
    } catch { return null; }
}
const csrfFor = (key, userId) => sign(key, `csrf:${userId}`);
const cookie = (value, maxAgeSec) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
const safeNext = next => (typeof next === 'string' && /^\/(transcript\/[A-Za-z0-9_-]{20,64}|tickets)(\?[^\s]*)?$/.test(next)) ? next : '/tickets';

const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function headers(res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': CSP });
}
function page(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:dark}body{margin:0;background:#101114;color:#e7e3d8;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.muted{color:#9a968c}
a{color:#e9c46a}.card{background:#1a1b20;border:1px solid #2a2b31;border-radius:10px;padding:16px}.center{max-width:420px;margin:12vh auto;text-align:center}
.button,button{display:inline-block;background:#d4af37;color:#141414;border:0;border-radius:8px;padding:10px 16px;font-weight:600;text-decoration:none;cursor:pointer;font-size:14px}
button.secondary{background:#2a2b31;color:#e7e3d8}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{flex:1;min-width:140px}.stat b{display:block;font-size:22px}
form.search{display:flex;gap:8px;flex-wrap:wrap}input,select{background:#1a1b20;color:#e7e3d8;border:1px solid #2a2b31;border-radius:8px;padding:9px 10px;font-size:14px}input[type=search]{flex:1;min-width:180px}
.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #24252b;white-space:nowrap}th{color:#9a968c;font-weight:600}
td.reason{white-space:normal;min-width:180px}.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:#2a2b31}.open{background:#1f3b2a;color:#7ee2a8}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
</style></head><body>${body}</body></html>`;
}
const message = (title, text, button) => page(title, `<div class="wrap"><div class="card center"><h1>${esc(title)}</h1><p class="muted">${text}</p>${button || ''}</div></div>`);

async function memberOf(client, userId) {
    const guild = client.guilds.cache.get(require('./TicketPanels').SETTINGS.guildId);
    return guild ? guild.members.fetch(userId).catch(() => null) : null;
}
async function isStaffUser(client, userId, panelKey) {
    const member = await memberOf(client, userId);
    if (!member) return false;
    if (member.permissions.has(P.Administrator) || member.permissions.has(P.ManageGuild)) return true;
    const { PANELS } = require('./TicketPanels');
    const panels = panelKey ? [PANELS[panelKey]].filter(Boolean) : Object.values(PANELS);
    return panels.some(panel => tickets().isStaff(member, panel));
}

function install(app, client) {
    const express = require('express');
    const gate = (req, res, next) => {
        headers(res);
        if (!verify().fromGateway(req)) return res.status(404).type('text').send('Not found');
        next();
    };
    const loginRedirect = (res, next) => res.redirect(302, `/tickets/auth/login?next=${encodeURIComponent(next)}`);

    // ---- sign in with Discord
    app.get('/tickets/auth/login', gate, (req, res) => {
        const cfg = settings(client);
        if (!cfg.secret || !cfg.clientId) return res.status(503).type('html').send(message('Sign-in unavailable', 'Discord sign-in is not configured yet.'));
        const state = crypto.randomBytes(18).toString('base64url');
        states.set(state, { next: safeNext(req.query.next), exp: Date.now() + 10 * 60_000 });
        for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
        const url = new URL('https://discord.com/oauth2/authorize');
        url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: cfg.redirectUri, scope: 'identify', state, prompt: 'none' }).toString();
        res.redirect(302, url.toString());
    });
    app.get('/tickets/auth/callback', gate, async (req, res) => {
        const cfg = settings(client);
        const entry = states.get(String(req.query.state || ''));
        states.delete(String(req.query.state || ''));
        if (!entry || entry.exp < Date.now() || !req.query.code) return res.status(400).type('html').send(message('Sign-in expired', 'Please open the link again.'));
        try {
            const token = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
                body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.secret, grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: cfg.redirectUri })
            }).then(r => r.ok ? r.json() : Promise.reject(new Error('token ' + r.status)));
            const user = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000) })
                .then(r => r.ok ? r.json() : Promise.reject(new Error('user ' + r.status)));
            if (!/^\d{17,20}$/.test(user.id)) throw new Error('bad user');
            res.set('Set-Cookie', cookie(makeSession(cfg.key, user.id), SESSION_MS / 1000));
            res.redirect(302, entry.next);
        } catch (error) {
            console.error('[TicketWeb] Sign-in failed:', error.message);
            res.status(502).type('html').send(message('Sign-in failed', 'Discord did not confirm your account. Please try again.'));
        }
    });
    app.get('/tickets/auth/logout', gate, (req, res) => {
        res.set('Set-Cookie', cookie('', 0));
        res.type('html').send(message('Signed out', 'You have been signed out.'));
    });

    // ---- transcripts (opener or staff only)
    app.get('/transcript/:token', gate, async (req, res) => {
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) return res.status(404).type('text').send('Not found');
        const cfg = settings(client);
        const userId = readSession(cfg.key, req);
        if (!userId) return loginRedirect(res, `/transcript/${req.params.token}`);
        try {
            const doc = await tickets().Transcripts().findById(req.params.token).lean();
            if (!doc) return res.status(404).type('html').send(message('Transcript not found', 'This transcript does not exist or was removed.'));
            const ticket = await tickets().Tickets().findById(doc.ticketId).lean();
            const allowed = ticket?.ownerId === userId || await isStaffUser(client, userId, ticket?.panel);
            if (!allowed) return res.status(403).type('html').send(message('No access', 'Only the person who opened this ticket and DealDesk staff can view this transcript.', '<a class="button" href="/tickets/auth/logout">Use another account</a>'));
            res.type('html').send(doc.html);
        } catch {
            res.status(503).type('text').send('Transcripts are temporarily unavailable');
        }
    });

    // ---- staff dashboard
    const staffOnly = async (req, res) => {
        const cfg = settings(client);
        const userId = readSession(cfg.key, req);
        if (!userId) { loginRedirect(res, '/tickets'); return null; }
        if (!await isStaffUser(client, userId)) {
            res.status(403).type('html').send(message('Staff only', 'The ticket dashboard is only for DealDesk staff.', '<a class="button" href="/tickets/auth/logout">Use another account</a>'));
            return null;
        }
        return { userId, cfg };
    };

    app.get('/tickets', gate, async (req, res) => {
        const who = await staffOnly(req, res); if (!who) return;
        try { res.type('html').send(await dashboard(client, who, req.query)); }
        catch (error) { console.error('[TicketWeb] Dashboard failed:', error.message); res.status(503).type('html').send(message('Unavailable', 'The dashboard could not load. Try again in a minute.')); }
    });
    app.post('/tickets/panels/:key', gate, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        const who = await staffOnly(req, res); if (!who) return;
        const { PANELS, SETTINGS } = require('./TicketPanels');
        const member = await memberOf(client, who.userId);
        if (!member?.permissions.has(P.ManageGuild) && !member?.permissions.has(P.Administrator)) return res.status(403).type('html').send(message('Managers only', 'Only server managers can open or close panels.', '<a class="button" href="/tickets">Back</a>'));
        if (req.body?.csrf !== csrfFor(who.cfg.key, who.userId) || !PANELS[req.params.key]) return res.status(400).type('html').send(message('Expired', 'Reload the dashboard and try again.', '<a class="button" href="/tickets">Back</a>'));
        const guild = client.guilds.cache.get(SETTINGS.guildId);
        await tickets().setDisabled(guild, req.params.key, req.body.state === 'disable');
        console.log(`[TicketWeb] ${who.userId} set ${req.params.key} to ${req.body.state}`);
        res.redirect(303, '/tickets');
    });
    console.log('[Tickets] Online transcripts (sign-in protected) and dashboard ready at /transcript and /tickets');
}

async function dashboard(client, who, query) {
    const { PANELS, SETTINGS } = require('./TicketPanels');
    const T = tickets().Tickets(), TR = tickets().Transcripts();
    const q = String(query.q || '').trim().slice(0, 64);
    const status = ['open', 'closed'].includes(query.status) ? query.status : 'all';
    const filter = { guildId: SETTINGS.guildId };
    if (status !== 'all') filter.status = status;
    if (/^\d{1,7}$/.test(q)) filter.number = Number(q);
    else if (/^\d{17,20}$/.test(q)) filter.$or = [{ ownerId: q }, { claimedBy: q }, { closedBy: q }];
    else if (q) filter.ownerName = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const rows = await T.find(filter).sort({ openedAt: -1 }).limit(100).lean();
    const links = new Map((await TR.find({ ticketId: { $in: rows.map(r => r._id) } }, { _id: 1, ticketId: 1 }).lean()).map(t => [t.ticketId, t._id]));
    const since = d => new Date(Date.now() - d * 86400_000);
    const [openNow, closed7, rated] = await Promise.all([
        T.countDocuments({ guildId: SETTINGS.guildId, status: 'open' }),
        T.countDocuments({ guildId: SETTINGS.guildId, status: 'closed', closedAt: { $gte: since(7) } }),
        T.find({ guildId: SETTINGS.guildId, rating: { $gte: 1 }, closedAt: { $gte: since(30) } }, { rating: 1 }).lean()
    ]);
    const avg = rated.length ? (rated.reduce((a, r) => a + r.rating, 0) / rated.length).toFixed(2) : '—';
    const name = id => id ? esc(client.users.cache.get(id)?.username || id) : '—';
    const date = d => d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';
    const member = await memberOf(client, who.userId);
    const manager = member?.permissions.has(P.ManageGuild) || member?.permissions.has(P.Administrator);
    const csrf = csrfFor(who.cfg.key, who.userId);
    const panelRows = await Promise.all(Object.values(PANELS).map(async p => {
        const off = await tickets().isDisabled(SETTINGS.guildId, p.key);
        const toggle = manager ? `<form method="post" action="/tickets/panels/${p.key}" style="display:inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="state" value="${off ? 'enable' : 'disable'}"><button class="${off ? '' : 'secondary'}">${off ? 'Enable' : 'Disable'}</button></form>` : '';
        return `<tr><td>${esc(p.title.trim())}</td><td><span class="pill ${off ? '' : 'open'}">${off ? 'Disabled' : 'Enabled'}</span></td><td>${toggle}</td></tr>`;
    }));
    const view = r => links.get(r._id) ? `<a href="/transcript/${links.get(r._id)}">Transcript</a>` : r.status === 'open' ? `<a href="https://discord.com/channels/${SETTINGS.guildId}/${r._id}">Open in Discord</a>` : '—';
    const body = rows.map(r => `<tr>
<td>#${r.number}</td><td>${view(r)}</td><td>${esc((PANELS[r.panel]?.title || r.panel || '').trim())}</td><td>${esc(r.ownerName || r.ownerId)}</td><td>${name(r.claimedBy)}</td>
<td><span class="pill ${r.status === 'open' ? 'open' : ''}">${esc(r.status)}</span></td><td>${date(r.openedAt)}</td><td>${date(r.closedAt)}</td>
<td>${r.rating ? '⭐'.repeat(r.rating) : '—'}</td><td class="reason">${esc(r.closeReason || '')}</td></tr>`).join('');
    return page('DealDesk tickets', `<div class="wrap">
<div class="top"><div><h1>DealDesk tickets</h1><div class="muted">Signed in as ${name(who.userId)} · <a href="/tickets/auth/logout">Sign out</a></div></div></div>
<h2>Overview</h2><div class="stats"><div class="card stat"><span class="muted">Open now</span><b>${openNow}</b></div><div class="card stat"><span class="muted">Closed in 7 days</span><b>${closed7}</b></div><div class="card stat"><span class="muted">Avg rating (30 days)</span><b>${avg}</b><span class="muted">${rated.length} ratings</span></div></div>
<h2>Panels</h2><div class="card table"><table><tr><th>Panel</th><th>Status</th><th></th></tr>${panelRows.join('')}</table>${manager ? '' : '<p class="muted">Only managers can change panels.</p>'}</div>
<h2>Tickets</h2><form class="search" method="get" action="/tickets"><input type="search" name="q" value="${esc(q)}" placeholder="Ticket number, username or Discord ID"><select name="status">${['all', 'open', 'closed'].map(s => `<option value="${s}"${s === status ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select><button>Search</button></form>
<div class="card table" style="margin-top:10px"><table><tr><th>#</th><th></th><th>Panel</th><th>Opened by</th><th>Claimed by</th><th>Status</th><th>Opened (UTC)</th><th>Closed (UTC)</th><th>Rating</th><th>Reason</th></tr>${body || '<tr><td colspan="10" class="muted">No tickets found.</td></tr>'}</table></div>
<p class="muted">Showing up to 100 tickets, newest first. Tickets from Tickets v2 are not included.</p></div>`);
}

module.exports = { install, makeSession, readSession, safeNext, csrfFor, settings, dashboard };
