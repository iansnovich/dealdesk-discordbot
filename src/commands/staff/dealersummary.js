const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { PurchaseData } = require('../../Datastores/PurchaseData');
const Emojis = require('../../constants/emojis');

const cfg = require('../../config');
const allowedRoleId = cfg.roles.dealer;

module.exports = {
    data: new SlashCommandBuilder()
        .setName("dealersummary")
        .setDescription("Check dealer sales and commission, with a personal or public result.")
        .setDMPermission(false)
        .addUserOption(option =>
            option.setName('dealer')
                .setDescription('The dealer to check sales for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('timeframe')
                .setDescription('Select timeframe, specific month, or year')
                .setRequired(true)
                .addChoices(
                    { name: '🌐 All-Time (Trial Period)', value: 'all' },
                    { name: '📅 Current Week (This Week)', value: 'current_week' },
                    { name: '⏪ Previous Week (Last Week)', value: 'prev_week' },
                    { name: '📊 4-Week Granular Breakdown Matrix', value: 'month_weeks' },
                    { name: '📈 Past 30 Days (Rolling)', value: 'past_30_days' },
                    // Dynamic recent months for quick selection
                    { name: '🗓️ Last Month (Previous Calendar Month)', value: 'last_calendar_month' },
                    { name: '🗓️ This Month (Current Calendar Month)', value: 'this_calendar_month' },
                    { name: '📅 Specific Month: July 2026', value: 'month_2026_07' },
                    { name: '📅 Specific Month: June 2026', value: 'month_2026_06' },
                    { name: '📅 Specific Month: May 2026', value: 'month_2026_05' },
                    // Yearly options
                    { name: '📆 Full Year: 2026', value: 'year_2026' },
                    { name: '📆 Full Year: 2025', value: 'year_2025' }
                ))
        .addNumberOption(option =>
            option.setName('rate')
                .setDescription('Custom commission percentage (Default is 5 for 5%)')
                .setRequired(false)
                .setMinValue(0)
                .setMaxValue(100))
        .addStringOption(option => option.setName('scope')
            .setDescription('Who can see the result? Personal by default; public posts it in this channel.')
            .addChoices({ name: 'Personal — only me', value: 'personal' }, { name: 'Public — everyone in this channel', value: 'public' })),

    async execute(interaction) {
        const hasRole = interaction.guildId && interaction.member?.roles?.cache?.has(allowedRoleId);

        if (!hasRole) {
            return await interaction.reply({ 
                content: "❌ You do not have the required role to view dealer revenue summaries.", 
                flags: MessageFlags.Ephemeral 
            });
        }

        const isPublic = interaction.options.getString('scope') === 'public';
        await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

        try {
            const dealer = interaction.options.getUser('dealer');
            const timeframe = interaction.options.getString('timeframe');
            const customRate = interaction.options.getNumber('rate') ?? 5; 

            let matchQuery = { seller: dealer.id, type: "R$" };
            let timeframeLabel = "";

            const now = new Date();

            const getStartOfWeek = (date) => {
                const d = new Date(date);
                const day = d.getUTCDay();
                const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
                d.setUTCDate(diff);
                d.setUTCHours(0, 0, 0, 0);
                return d;
            };

            // Timeframe filtering logic
            if (timeframe === 'all') {
                timeframeLabel = "All-Time Trial Period";
            } 
            else if (timeframe === 'current_week') {
                const startThisWeek = getStartOfWeek(now);
                matchQuery.timestamp = { $gte: startThisWeek };
                timeframeLabel = "Current Business Week (Mon-Present)";
            } 
            else if (timeframe === 'prev_week') {
                const startThisWeek = getStartOfWeek(now);
                const startPrevWeek = new Date(startThisWeek);
                startPrevWeek.setUTCDate(startPrevWeek.getUTCDate() - 7);
                matchQuery.timestamp = { $gte: startPrevWeek, $lt: startThisWeek };
                timeframeLabel = "Previous Business Week (Last Mon - Sun)";
            } 
            else if (timeframe === 'past_30_days') {
                const thirtyDaysAgo = new Date(now);
                thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
                matchQuery.timestamp = { $gte: thirtyDaysAgo };
                timeframeLabel = "Past 30 Days Rolling";
            }
            else if (timeframe === 'this_calendar_month') {
                const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
                matchQuery.timestamp = { $gte: startMonth };
                timeframeLabel = `Current Calendar Month (${now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })})`;
            }
            else if (timeframe === 'last_calendar_month') {
                const startLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
                const endLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
                matchQuery.timestamp = { $gte: startLastMonth, $lt: endLastMonth };
                timeframeLabel = `Previous Calendar Month (${startLastMonth.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })})`;
            }
            else if (timeframe.startsWith('month_')) {
                // Format: month_YYYY_MM (Note: MM is zero-indexed string in code or parsed directly)
                const parts = timeframe.split('_');
                const year = parseInt(parts[1]);
                const monthIndex = parseInt(parts[2]) - 1; // Convert 1-indexed to 0-indexed month

                const startMonth = new Date(Date.UTC(year, monthIndex, 1));
                const endMonth = new Date(Date.UTC(year, monthIndex + 1, 1));
                matchQuery.timestamp = { $gte: startMonth, $lt: endMonth };
                timeframeLabel = startMonth.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            }
            else if (timeframe.startsWith('year_')) {
                const year = parseInt(timeframe.split('_')[1]);
                const startYear = new Date(Date.UTC(year, 0, 1));
                const endYear = new Date(Date.UTC(year + 1, 0, 1));
                matchQuery.timestamp = { $gte: startYear, $lt: endYear };
                timeframeLabel = `Full Calendar Year ${year}`;
            }

            const embed = new EmbedBuilder()
                .setTitle(`Dealer summary`)
                .setColor("Gold")
                .setThumbnail(dealer.displayAvatarURL({ dynamic: true }))
                .setDescription(`<@${dealer.id}> · ${timeframeLabel}`);

            // SPECIAL MULTI-WEEK MATRIX VIEW
            if (timeframe === 'month_weeks') {
                const currentWeekStart = getStartOfWeek(now);
                const weeksConfig = [];
                for (let i = 0; i < 4; i++) {
                    const end = new Date(currentWeekStart);
                    end.setUTCDate(end.getUTCDate() - (7 * i));
                    const start = new Date(end);
                    start.setUTCDate(start.getUTCDate() - 7);
                    weeksConfig.push({ index: i, start, end });
                }

                let grandTotalSales = 0;
                let grandTotalOrders = 0;

                for (const w of weeksConfig.reverse()) {
                    const weekSummary = await PurchaseData.aggregate([
                        { 
                            $match: { 
                                seller: dealer.id, 
                                type: "R$",
                                timestamp: { $gte: w.start, $lt: w.end }
                            } 
                        },
                        { 
                            $group: { 
                                _id: null, 
                                totalSales: { $sum: "$amount" },
                                totalOrders: { $sum: 1 } 
                            } 
                        }
                    ]);

                    const wSales = weekSummary.length > 0 ? weekSummary[0].totalSales : 0;
                    const wOrders = weekSummary.length > 0 ? weekSummary[0].totalOrders : 0;
                    const wCommission = wSales * (customRate / 100);

                    grandTotalSales += wSales;
                    grandTotalOrders += wOrders;

                    const startDateStr = w.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
                    const endDateStr = new Date(w.end.getTime() - 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

                    embed.addFields({
                        name: `${startDateStr} – ${endDateStr}`,
                        value: `• **Orders:** ${wOrders} sales\n• **Volume:** ${wSales.toLocaleString()} R$ ${Emojis.robux || ''}\n• **Commission (${customRate}%):** **${wCommission.toLocaleString()} R$**`,
                        inline: false
                    });
                }

                const grandTotalCommission = grandTotalSales * (customRate / 100);
                embed.addFields(
                    { name: "4-week totals", value: `**Total Orders:** ${grandTotalOrders} sales\n**Total Volume:** ${grandTotalSales.toLocaleString()} R$ ${Emojis.robux || ''}\n**Total Commission Owed:** **${grandTotalCommission.toLocaleString()} R$**`, inline: false }
                );

            } else {
                // STANDARD SINGLE RANGE AGGREGATION
                const summary = await PurchaseData.aggregate([
                    { $match: matchQuery },
                    { 
                        $group: { 
                            _id: "$seller", 
                            totalSales: { $sum: "$amount" },
                            totalOrders: { $sum: 1 } 
                        } 
                    }
                ]);

                const totalSales = summary.length > 0 ? summary[0].totalSales : 0;
                const totalOrders = summary.length > 0 ? summary[0].totalOrders : 0;
                const commissionOwed = totalSales * (customRate / 100);

                embed.addFields(
                    { name: "Orders", value: `**${totalOrders}** sales`, inline: true },
                    { name: "Robux sold", value: `**${totalSales.toLocaleString()} R$** ${Emojis.robux || ''}`, inline: true },
                    { name: `Commission (${customRate}%)`, value: `**${commissionOwed.toLocaleString()} R$**`, inline: false }
                );
            }

            // Ticket handling stats (recorded from Tickets v2 claims since ticket routing went live).
            try {
                let range = matchQuery.timestamp;
                if (timeframe === 'month_weeks') {
                    const end = getStartOfWeek(now);
                    const start = new Date(end);
                    start.setUTCDate(start.getUTCDate() - 28);
                    range = { $gte: start, $lt: end };
                }
                const stats = await require('../../DealerTicketQueue').dealerTicketStats(dealer.id, range);
                // Buyer star ratings from DealDesk tickets this dealer handled.
                let ratingLine = '';
                try {
                    const rated = await require('../../Tickets').Tickets()
                        .find({ claimedBy: dealer.id, rating: { $gte: 1 }, ...(range ? { closedAt: range } : {}) }, { rating: 1 }).lean();
                    if (rated.length) ratingLine = `\nBuyer rating: **${(rated.reduce((a, r) => a + r.rating, 0) / rated.length).toFixed(2)} ⭐** from ${rated.length} rating${rated.length === 1 ? '' : 's'}`;
                } catch { /* ratings are optional */ }
                const span = ms => {
                    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
                    const m = Math.max(0, Math.round(ms / 60000));
                    return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
                };
                embed.addFields({
                    name: '🎫 Tickets',
                    value: stats.claimed || stats.openNow
                        ? `**${stats.claimed}** claimed · **${stats.closed}** closed · **${stats.unclaimed}** unclaimed\n` +
                          `Avg time to claim: **${span(stats.avgClaimMs)}** · Avg claim → close: **${span(stats.avgCloseMs)}**\n` +
                          `Open right now: **${stats.openNow}**` + ratingLine
                        : 'No claimed tickets recorded for this period yet.',
                    inline: false
                });
            } catch (error) {
                console.error('Dealer ticket stats unavailable:', error.name);
            }

            embed
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });

        } catch (error) {
            console.error("Error generating dealer summary:", error);
            await interaction.editReply({ content: "Could not load the dealer summary. Try again shortly." });
        }
    }
};
