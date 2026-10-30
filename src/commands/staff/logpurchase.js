const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const { PurchaseData } = require('../../Datastores/PurchaseData');
const UserSettings = require('../../Datastores/UserSettings');
const Emojis = require('../../constants/emojis');
const { resolveRecipients, recipientLinks, recipientInput } = require('../../PayoutRecipients');
const { syncPurchaseRoles } = require('../../PurchaseRoles');
const { showResult } = require('../../DiscordResults');

const cfg = require('../../config');
const logsChannelId = cfg.channels.purchaseLogs;
const totalSoldChannelId = cfg.channels.totalSoldCounter;
const staffRoleId = cfg.roles.jrDealer;

module.exports = {
    data: new SlashCommandBuilder()
        .setName("logpurchase")
        .setDescription("Log a buyer's Robux purchase, send embed to logs channel, and send a receipt DM.")
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The buyer')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('amount')
                .setDescription('Amount of Robux bought (e.g., 2000)')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('type')
                .setDescription('Currency type (Strictly Robux)')
                .setRequired(true)
                .addChoices(
                    { name: 'Robux (R$)', value: 'R$' }
                ))
        .addStringOption(option => 
            option.setName('price')
                .setDescription('Optional price detail (e.g., "12 USD" or "₹1000")')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('recipients')
                .setDescription('Roblox recipients: up to 10 usernames, IDs or profile links, separated by spaces or commas')
                .setMaxLength(1500)
                .setRequired(false)),

    async execute(interaction) {
        const isAuthorized = 
            interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
            interaction.member.roles.cache.has(staffRoleId);

        if (!isAuthorized) {
            return await interaction.reply({ 
                content: "You do not have permission to use this command.", 
                flags: MessageFlags.Ephemeral 
            });
        }

        await interaction.deferReply();
        let purchaseSaved = false;
        try {
            const buyer = interaction.options.getUser('user');
            const amountStr = interaction.options.getString('amount');
            const type = interaction.options.getString('type');
            const price = interaction.options.getString('price'); 
            const seller = interaction.user; 

            const parsedAmount = Number(amountStr.replace(/,/g, '').trim());
            if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
                return interaction.editReply({ content: 'Enter a positive whole Robux amount. Nothing was logged.' });
            }
            let recipients;
            try {
                const explicit = interaction.options.getString('recipients');
                const input = await recipientInput(explicit, {
                    guildId: interaction.guildId, channelId: interaction.channelId, buyerId: buyer.id
                }, {
                    ticket: async (guildId, channelId, ownerId) => {
                        const mongoose = require('mongoose');
                        const collection = mongoose.models.TicketRoblox?.collection.name || mongoose.pluralize()('TicketRoblox');
                        return mongoose.connection.collection(collection).findOne({ guildId, channelId, ownerId }, { maxTimeMS: 5000 });
                    },
                    linked: id => require('../../RobloxLinks').linkedUser(id),
                    saved: async id => (await UserSettings.findOne({ user: id }).lean().maxTimeMS(5000))?.robloxUsernames
                });
                recipients = await resolveRecipients(input);
            } catch (error) {
                return interaction.editReply({ content: `${error.message} Nothing was logged. Correct the recipients and try again.` });
            }
            const links = recipientLinks(recipients);
            const unixTime = Math.floor(Date.now() / 1000);

            const newPurchase = new PurchaseData({
                user: buyer.id,
                amount: parsedAmount,
                type: type,
                seller: seller.id,
                price: price || null,
                timestamp: new Date()
            });

            await newPurchase.save();
            purchaseSaved = true;
            // Confirm the durable save first; role API delays cannot leave this loading.
            void syncPurchaseRoles(interaction.guild, buyer.id).then(result => {
                if (result.status !== 'ok') return interaction.followUp({content:'Purchase saved, but the buyer’s role update needs attention. Do not log it again.',flags:MessageFlags.Ephemeral});
            }).catch(error => {
                console.error('[Purchase roles] Immediate sync failed:', error.code || error.message);
                return interaction.followUp({content:'Purchase saved. The role update could not be confirmed; the repair will retry it. Do not log it again.',flags:MessageFlags.Ephemeral}).catch(()=>{});
            });

            await showResult(interaction, { content: `Logged **${parsedAmount.toLocaleString()} R$** for <@${buyer.id}>.`, allowedMentions: { parse: [] } }).catch(error => console.error('[Purchase reply]',error.code || error.message));

            const logEmbed = new EmbedBuilder()
                .setTitle(`${Emojis.robux} Purchase Logged Successfully`)
                .setColor("Green")
                .addFields(
                    { name: "👤 Buyer", value: `<@${buyer.id}>`, inline: true },
                    { name: `${Emojis.robux} Amount`, value: `**${amountStr} R$**`, inline: true },
                    { name: "Seller", value: `<@${seller.id}>`, inline: true },
                    { name: "Logged", value: `<t:${unixTime}:R>`, inline: true }
                );

            if (price) {
                logEmbed.addFields({ name: "💳 Price Paid", value: `**${price}**`, inline: true });
            }
            if (links) logEmbed.addFields({ name: 'Roblox recipients', value: links });

            const logsChannel = interaction.guild.channels.cache.get(logsChannelId);
            if (logsChannel && logsChannel.isTextBased()) {
                void logsChannel.send({ embeds: [logEmbed] }).catch(err => console.error("Logs Channel Error:", err));
            }

            // The scheduled totals refresh owns channel renames. Repeated purchases
            // must not queue rate-limited rename requests ahead of receipt delivery.

            try {
                const userSettings = await UserSettings.findOne({ user: buyer.id });
                const canSendDM = userSettings ? !userSettings.dmDisabled : true; 

                if (canSendDM) {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle("🧾 Purchase Receipt")
                        .setDescription(links
                            ? `Paid out **${parsedAmount.toLocaleString('en-US')} Robux** to ${links}.`
                            : `Paid out **${parsedAmount.toLocaleString('en-US')} Robux** to you.`)
                        .setColor("Blue")
                        .addFields(
                            { name: `${Emojis.robux} Amount Received`, value: `**${amountStr} R$**`, inline: true },
                            { name: "Seller", value: `<@${seller.id}>`, inline: true },
                            { name: "Date", value: `<t:${unixTime}:R>`, inline: true }
                        );

                    if (price) {
                        dmEmbed.addFields({ name: "💳 Price Paid", value: `**${price}**`, inline: true });
                    }

                    await buyer.send({ embeds: [dmEmbed] });
                    console.log(`[DM Sent] Receipt delivered to ${buyer.tag}`);
                }
            } catch (dmErr) {
                console.log(`[DM Failed] Couldn't deliver DM to ${buyer.tag}`);
            }

        } catch (error) {
            console.error("Error logging purchase:", error);
            await showResult(interaction, { content: purchaseSaved
                ? 'The purchase was saved, but a follow-up step failed. Do not log it again.'
                : 'The purchase could not be confirmed. Check the purchase history before retrying.' });
        }
    }
};


