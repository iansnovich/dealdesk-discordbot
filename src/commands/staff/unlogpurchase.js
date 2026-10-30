const {
    SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ActionRowBuilder,
    StringSelectMenuBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const mongoose = require('mongoose');
const { PurchaseData } = require('../../Datastores/PurchaseData');
const { syncPurchaseRoles } = require('../../PurchaseRoles');

// Undo a purchase logged by mistake. Removes the record (so totals, tiers,
// /dealersummary and leaderboards drop it), re-syncs the buyer's tier roles,
// marks the original #logs entry as removed, and keeps an audit copy.
const cfg = require('../../config');
const logsChannelId = cfg.channels.purchaseLogs;
const staffRoleId = cfg.roles.jrDealer; // same role as /logpurchase
const OWN_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;
const reasons = new Map(); // userId -> reason typed in the command (kept for the confirm step)

const removedSchema = new mongoose.Schema({
    purchaseId: String, user: String, amount: Number, type: String, seller: String, timestamp: Date,
    removedBy: String, removedAt: Date, reason: String, logMessageId: String
}, { bufferCommands: false });
const Removed = () => mongoose.models.RemovedPurchase || mongoose.model('RemovedPurchase', removedSchema);

const isManager = member => member?.permissions?.has(PermissionFlagsBits.ManageMessages) || member?.permissions?.has(PermissionFlagsBits.ManageGuild);
// Managers can remove any log; staff can remove only their own logs from the last 24 hours.
function canRemove(member, record) {
    if (isManager(member)) return true;
    return member?.roles?.cache?.has(staffRoleId) && record.seller === member.id && Date.now() - new Date(record.timestamp).getTime() < OWN_LOG_WINDOW_MS;
}
const when = d => `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>`;
const fmt = n => Number(n).toLocaleString('en-US');

// Finds the #logs embed that /logpurchase posted for this record.
async function findLogMessage(guild, record) {
    const channel = guild.channels.cache.get(logsChannelId);
    if (!channel?.isTextBased()) return null;
    const recordTime = Math.floor(new Date(record.timestamp).getTime() / 1000);
    let before;
    for (let page = 0; page < 5; page++) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
        if (!batch?.size) return null;
        for (const message of batch.values()) {
            if (message.author?.id !== guild.client.user.id) continue;
            const embed = message.embeds?.[0];
            if (!embed || !/Purchase Logged/i.test(embed.title || '')) continue;
            const field = name => embed.fields?.find(f => f.name.includes(name))?.value || '';
            const logged = Number(field('Logged').match(/<t:(\d+)/)?.[1] || 0);
            if (field('Buyer').includes(record.user) && field('Seller').includes(record.seller || '-') && Math.abs(logged - recordTime) <= 120) return message;
        }
        before = batch.last().id;
        if (batch.size < 100) return null;
    }
    return null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unlogpurchase')
        .setDescription('Remove a purchase that was logged by mistake.')
        .setDMPermission(false)
        .addUserOption(o => o.setName('user').setDescription('The buyer whose purchase was logged by mistake').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Why it is being removed (shown in #logs)').setMaxLength(300)),

    async execute(interaction) {
        const member = interaction.member;
        if (!isManager(member) && !member?.roles?.cache?.has(staffRoleId)) {
            return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const buyer = interaction.options.getUser('user', true);
        const reason = (interaction.options.getString('reason') || '').trim();
        const records = await PurchaseData.find({ user: buyer.id }).sort({ timestamp: -1 }).limit(15).lean();
        const allowed = records.filter(r => canRemove(member, r));
        reasons.set(interaction.user.id, reason);
        setTimeout(() => { if (reasons.get(interaction.user.id) === reason) reasons.delete(interaction.user.id); }, 15 * 60 * 1000).unref?.();
        if (!records.length) return interaction.editReply({ content: `<@${buyer.id}> has no logged purchases.`, allowedMentions: { parse: [] } });
        if (!allowed.length) return interaction.editReply({ content: 'You can only remove purchases you logged in the last 24 hours. Ask a manager for older ones.' });

        const menu = new StringSelectMenuBuilder()
            .setCustomId(`unlog:pick:${interaction.user.id}`)
            .setPlaceholder('Choose the purchase to remove')
            .addOptions(allowed.slice(0, 25).map(r => ({
                label: `${fmt(r.amount)} ${r.type || 'R$'} · ${new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
                description: `Logged by ${interaction.guild.members.cache.get(r.seller)?.displayName || r.seller || 'unknown'}`.slice(0, 100),
                value: String(r._id)
            })));
        return interaction.editReply({
            content: `Recent purchases for <@${buyer.id}>. Pick the one that was logged by mistake. Nothing is removed until you confirm.`,
            components: [new ActionRowBuilder().addComponents(menu)],
            allowedMentions: { parse: [] }
        });
    },

    async handleComponent(interaction) {
        const [, action, ownerId] = interaction.customId.split(':');
        if (ownerId !== interaction.user.id) return interaction.reply({ content: 'This menu belongs to someone else.', flags: MessageFlags.Ephemeral });
        try {
            if (action === 'cancel') return interaction.update({ content: 'Cancelled. Nothing was removed.', components: [] });
            if (action === 'pick') {
                const record = await PurchaseData.findById(interaction.values[0]).lean();
                if (!record) return interaction.update({ content: 'That purchase was already removed.', components: [] });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`unlog:confirm:${ownerId}:${record._id}`).setLabel('Remove this purchase').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`unlog:cancel:${ownerId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                );
                return interaction.update({
                    content: `Remove **${fmt(record.amount)} R$** for <@${record.user}>, logged by <@${record.seller}> on ${when(record.timestamp)}?\nTheir totals and tier roles will be recalculated.`,
                    components: [row], allowedMentions: { parse: [] }
                });
            }
            if (action === 'confirm') {
                const parts = interaction.customId.split(':');
                const id = parts[3];
                const reason = reasons.get(ownerId) || '';
                await interaction.update({ content: 'Removing…', components: [] });
                const record = await PurchaseData.findById(id).lean();
                if (!record) return interaction.editReply({ content: 'That purchase was already removed.' });
                if (!canRemove(interaction.member, record)) return interaction.editReply({ content: 'You can no longer remove this purchase. Ask a manager.' });
                const log = await findLogMessage(interaction.guild, record).catch(() => null);
                const deleted = await PurchaseData.deleteOne({ _id: record._id });
                if (!deleted.deletedCount) return interaction.editReply({ content: 'That purchase was already removed.' });
                await Removed().create({
                    purchaseId: String(record._id), user: record.user, amount: record.amount, type: record.type, seller: record.seller, timestamp: record.timestamp,
                    removedBy: interaction.user.id, removedAt: new Date(), reason: reason || null, logMessageId: log?.id || null
                }).catch(error => console.error('[Unlog] Audit copy failed:', error.message));

                const note = `Removed by <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>${reason ? ` · ${reason}` : ''}`;
                if (log) {
                    const old = log.embeds[0].toJSON ? log.embeds[0].toJSON() : log.embeds[0].data || log.embeds[0];
                    await log.edit({ embeds: [{ ...old, title: 'Purchase Log Removed', color: 0xe74c3c, fields: [...(old.fields || []), { name: 'Removed', value: note }] }] }).catch(() => {});
                } else {
                    const channel = interaction.guild.channels.cache.get(logsChannelId);
                    await channel?.send({ embeds: [{ title: 'Purchase Log Removed', color: 0xe74c3c, fields: [
                        { name: 'Buyer', value: `<@${record.user}>`, inline: true },
                        { name: 'Amount', value: `**${fmt(record.amount)} R$**`, inline: true },
                        { name: 'Seller', value: `<@${record.seller}>`, inline: true },
                        { name: 'Originally logged', value: when(record.timestamp), inline: true },
                        { name: 'Removed', value: note }
                    ] }], allowedMentions: { parse: [] } }).catch(() => {});
                }
                const roles = await syncPurchaseRoles(interaction.guild, record.user).catch(() => ({ status: 'error' }));
                return interaction.editReply({
                    content: `Removed **${fmt(record.amount)} R$** for <@${record.user}>.${log ? ' The #logs entry is marked as removed.' : ''}${roles.status === 'ok' ? ' Their tier roles were updated.' : ' Their tier roles will be corrected by the next repair run.'}\nThe Total R$ Sold counter updates within 30 minutes.`,
                    allowedMentions: { parse: [] }
                });
            }
        } catch (error) {
            console.error('[Unlog] Failed:', error.message);
            const content = 'Something went wrong. Check the purchase history before trying again.';
            return (interaction.deferred || interaction.replied ? interaction.editReply({ content, components: [] }) : interaction.reply({ content, flags: MessageFlags.Ephemeral })).catch(() => {});
        }
    }
};
