'use strict';

async function resolveRecipients(input, request = fetch) {
    if (!input || !input.trim()) return [];
    const tokens = [...new Set(input.trim().split(/[\s,]+/))];
    if (tokens.length > 10) throw new Error('Use at most 10 Roblox recipients.');
    const resolved = new Array(tokens.length);
    async function resolveToken(token) {
        const profile = token.match(/^https:\/\/(?:www\.)?roblox\.com\/users\/([1-9]\d*)\/profile\/?(?:[?#].*)?$/i);
        const id = profile?.[1] || (/^[1-9]\d*$/.test(token) ? token : null);
        const username = token.replace(/^@/, '');
        if (!id && !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
            throw new Error('Recipients must be Roblox usernames, numeric IDs or Roblox profile links.');
        }
        let user;
        try {
            const response = await request(id ? `https://users.roblox.com/v1/users/${id}` : 'https://users.roblox.com/v1/usernames/users', {
                method: id ? 'GET' : 'POST',
                ...(id ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) }),
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) throw new Error('lookup');
            const result = await response.json();
            user = id ? result : result.data?.[0];
        } catch {
            throw new Error('Roblox could not verify the recipients right now.');
        }
        if (!Number.isSafeInteger(user?.id) || user.id <= 0 || !/^[A-Za-z0-9_]{3,20}$/.test(user?.name || '')) {
            throw new Error('A Roblox recipient could not be found.');
        }
        return { id: user.id, name: user.name };
    }
    // Bound Roblox lookup concurrency; multiple recipients no longer cost one full timeout each.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, tokens.length) }, async () => {
        while (next < tokens.length) { const index = next++; resolved[index] = await resolveToken(tokens[index]); }
    }));
    return resolved.filter((user,index) => resolved.findIndex(other => other.id === user.id) === index);
}

function recipientLinks(recipients) {
    return recipients.map(user => `[${user.name.replace(/_/g, '\\_')}](https://www.roblox.com/users/${user.id}/profile)`).join(', ');
}

async function recipientInput(explicit, context, stores) {
    if (explicit?.trim()) return explicit;
    const ticket = await stores.ticket(context.guildId, context.channelId, context.buyerId);
    if (ticket) {
        if (ticket.status !== 'confirmed') return null;
        if (ticket.accounts?.length) return ticket.accounts.map(u => u.robloxId).join(',');
        if (!ticket.robloxId) return null;
        return ticket.robloxId;
    }
    const linked = await stores.linked(context.buyerId);
    if (linked) return linked;
    const saved = [...new Set((await stores.saved(context.buyerId) || []).map(v => v.trim()).filter(Boolean).map(v => v.toLowerCase()))];
    if (saved.length > 1) return null;
    return saved[0] || null;
}

module.exports = { resolveRecipients, recipientLinks, recipientInput };
