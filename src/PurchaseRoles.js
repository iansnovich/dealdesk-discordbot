'use strict';
// [minimum lifetime R$, role ID] pairs, from config.json
const thresholds = require('./config').purchaseTiers.map(t => [t.minRobux, t.roleId]);

function createService({ PurchaseData, guildId, logger = console }) {
    const pending = new Map();
    async function apply(guild, userId) {
        if (!guildId || guild.id !== guildId) return { status: 'wrong-guild' };
        const rows = await PurchaseData.aggregate([
            { $match: { user: userId, type: 'R$' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const total = rows[0]?.total ?? 0;
        if (!Number.isFinite(total) || total < 0) throw new Error('Invalid purchase total; roles unchanged');
        let member;
        try { member = await guild.members.fetch({ user: userId, force: true }); }
        catch (error) { if (error.code === 10007) return { status: 'not-member' }; throw error; }
        if (member.user.bot) return { status: 'bot' };
        const roles = guild.roles.cache;
        const added = [], removed = [], failed = [];
        for (const [threshold, id] of thresholds) {
            const earned = total >= threshold;
            if (earned === member.roles.cache.has(id)) continue;
            const role = roles.get(id);
            if (!role || !role.editable) {
                failed.push(id);
                logger.warn(`[Purchase roles] Cannot manage reward role ${id}; check role hierarchy and Manage Roles.`);
                continue;
            }
            try {
                if (earned) { await member.roles.add(id, 'Purchase total reward'); added.push(id); }
                else { await member.roles.remove(id, 'Purchase total reward reconciliation'); removed.push(id); }
            } catch (error) {
                failed.push(id);
                logger.warn(`[Purchase roles] Role ${id} update failed (${error.code || 'request-error'}).`);
            }
        }
        if (added.length || removed.length) logger.log(`[Purchase roles] Updated ${userId}: ${added.length} added, ${removed.length} removed.`);
        return { status: failed.length ? 'partial' : 'ok', added, removed, failed };
    }
    function sync(guild, userId) {
        const key = `${guild.id}:${userId}`;
        // Immediate purchases and the periodic repair share a per-member queue.
        // Read totals inside the queue so an older sweep cannot undo a new tier.
        const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => apply(guild, userId));
        pending.set(key, task);
        const cleanup = () => { if (pending.get(key) === task) pending.delete(key); };
        task.then(cleanup, cleanup);
        return task;
    }
    return { sync };
}
let service;
function syncPurchaseRoles(guild, userId) {
    service ||= createService({ PurchaseData: require('./Datastores/PurchaseData').PurchaseData,
        guildId: require('./config').guildId });
    return service.sync(guild, userId);
}
module.exports = { thresholds, createService, syncPurchaseRoles };
