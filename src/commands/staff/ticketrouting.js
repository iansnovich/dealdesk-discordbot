const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
const { getModel } = require('../../DealerTicketQueue');

const cfg = require('../../config');
const TARGET_GUILD = cfg.guildId;

// Accepts a raw snowflake ID or a <@id>, <@!id>, <#id> mention.
function parseId(value) {
    const match = String(value || '').trim().match(/^(?:<[@#]!?)?(\d{17,20})>?$/);
    return match ? match[1] : null;
}

async function fetchCategory(guild, id) {
    const category = await guild.channels.fetch(id).catch(() => null);
    return category && category.guildId === guild.id && category.type === ChannelType.GuildCategory ? category : null;
}

// Category picked from the menu or pasted as an ID/mention. Returns { category } | { error } | {} when neither given.
async function resolveCategory(interaction) {
    const picked = interaction.options.getChannel('category');
    const raw = interaction.options.getString('category_id');
    if (picked && raw) return { error: 'Use either `category` or `category_id`, not both.' };
    if (!picked && !raw) return {};
    const id = picked ? picked.id : parseId(raw);
    if (!id) return { error: `\`${raw}\` is not a valid category ID.` };
    const category = await fetchCategory(interaction.guild, id);
    return category ? { category } : { error: `\`${id}\` is not a category in this server.` };
}

async function resolveDealer(interaction) {
    const picked = interaction.options.getUser('dealer');
    const raw = interaction.options.getString('dealer_id');
    if (picked && raw) return { error: 'Use either `dealer` or `dealer_id`, not both.' };
    if (!picked && !raw) return { error: 'Choose a `dealer` or paste a `dealer_id`.' };
    if (picked) return { id: picked.id, username: picked.username, label: picked.username };
    const id = parseId(raw);
    if (!id) return { error: `\`${raw}\` is not a valid user ID.` };
    // Routing only needs the ID, so an unresolvable user is still accepted.
    const user = await interaction.client.users.fetch(id).catch(() => null);
    return { id, username: user?.username || null, label: user?.username || id };
}

// Reuses a category with the exact same name, otherwise creates a private one
// next to the watched open-ticket category.
async function findOrCreateCategory(interaction, name, dealerId, sourceCategoryId) {
    const guild = interaction.guild;
    const all = await guild.channels.fetch();
    const matches = all.filter(channel => channel?.type === ChannelType.GuildCategory && channel.name.toLowerCase() === name.toLowerCase());
    if (matches.size > 1) return { error: `More than one category is named **${name}**. Pass \`category_id\` to pick one.` };
    if (matches.size === 1) return { category: matches.first(), created: false };

    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) return { error: 'DealDesk needs the **Manage Channels** permission to create categories.' };

    const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] }
    ];
    const dealerMember = await guild.members.fetch(dealerId).catch(() => null);
    if (dealerMember) overwrites.push({ id: dealerId, allow: [PermissionFlagsBits.ViewChannel] });

    const source = sourceCategoryId ? all.get(sourceCategoryId) : null;
    const category = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites,
        ...(source ? { position: source.position + 1 } : {}),
        reason: `Ticket routing category for ${dealerId} (by ${interaction.user.id})`
    });
    return { category, created: true };
}

const categoryOptions = (command, description) => command
    .addChannelOption(option => option.setName('category').setDescription(description).addChannelTypes(ChannelType.GuildCategory))
    .addStringOption(option => option.setName('category_id').setDescription('Or paste the category ID instead.'));

module.exports = {
    parseId,
    data: new SlashCommandBuilder()
        .setName('ticket-routing')
        .setDescription('Configure automatic routing for claimed Tickets v2 channels.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(command => categoryOptions(
            command.setName('watch').setDescription('Set the open-ticket category to monitor.'),
            'Tickets v2 category where new tickets appear.'))
        .addSubcommand(command => categoryOptions(
            command.setName('map').setDescription('Map a dealer to a category (creates one if none is given).')
                .addUserOption(option => option.setName('dealer').setDescription('Dealer who claims tickets.'))
                .addStringOption(option => option.setName('dealer_id').setDescription('Or paste the dealer’s user ID instead.')),
            'Existing category for this dealer’s tickets.')
            .addStringOption(option => option.setName('name').setDescription('Name for a new category (defaults to the dealer’s username).').setMaxLength(100)))
        .addSubcommand(command => command.setName('unmap').setDescription('Remove a dealer’s category mapping.')
            .addUserOption(option => option.setName('dealer').setDescription('Dealer to remove.'))
            .addStringOption(option => option.setName('dealer_id').setDescription('Or paste the dealer’s user ID instead.')))
        .addSubcommand(command => command.setName('limit').setDescription('Set how many tickets a dealer can hold in their category.')
            .addIntegerOption(option => option.setName('max').setDescription('Most tickets one dealer can have in their category (default 10).').setRequired(true).setMinValue(1).setMaxValue(50)))
        .addSubcommand(command => command.setName('list').setDescription('Show the automatic routing setup.')),

    async execute(interaction) {
        const reply = content => interaction.editReply ? interaction.editReply({ content }) : interaction.reply({ content, flags: MessageFlags.Ephemeral });
        if (interaction.guildId !== TARGET_GUILD) return interaction.reply({ content: 'This setup is only available in the DealDesk server.', flags: MessageFlags.Ephemeral });
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Only server managers can configure ticket routing.', flags: MessageFlags.Ephemeral });
        if (mongoose.connection.readyState !== 1) return interaction.reply({ content: 'Ticket routing storage is temporarily unavailable.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            return await run(interaction, reply);
        } catch (error) {
            console.error('[Ticket routing] Command failed:', error);
            return reply(`Something went wrong: ${error.message || error.name}`).catch(() => {});
        }
    }
};

async function run(interaction, reply) {
        const Store = getModel();
        const action = interaction.options.getSubcommand();

        if (action === 'watch') {
            const { category, error } = await resolveCategory(interaction);
            if (error) return reply(error);
            if (!category) return reply('Choose a `category` or paste a `category_id`.');
            await Store.updateOne({ _id: interaction.guildId }, {
                $set: { sourceCategoryId: category.id },
                $setOnInsert: { sellers: [] }
            }, { upsert: true });
            return reply(`Watching ${category} (\`${category.id}\`) for Tickets v2 claims.`);
        }

        if (action === 'map') {
            const dealer = await resolveDealer(interaction);
            if (dealer.error) return reply(dealer.error);
            const resolved = await resolveCategory(interaction);
            if (resolved.error) return reply(resolved.error);
            const name = interaction.options.getString('name')?.trim() || null;
            if (resolved.category && name) return reply('`name` is only for creating a new category. Leave it out when you pick an existing one.');

            let category = resolved.category;
            let created = false;
            if (!category) {
                const categoryName = name || dealer.username;
                if (!categoryName) return reply(`Couldn’t look up a username for \`${dealer.id}\`. Pass \`name\` to name the category.`);
                const config = await Store.findById(interaction.guildId).lean();
                const made = await findOrCreateCategory(interaction, categoryName, dealer.id, config?.sourceCategoryId);
                if (made.error) return reply(made.error);
                ({ category, created } = made);
            }

            await Store.updateOne({ _id: interaction.guildId }, {
                $pull: { sellers: { userId: dealer.id } },
                $setOnInsert: { sourceCategoryId: null }
            }, { upsert: true });
            await Store.updateOne({ _id: interaction.guildId }, {
                $push: { sellers: { userId: dealer.id, categoryId: category.id } }
            });
            const how = created ? 'Created' : resolved.category ? 'Using' : 'Reusing existing';
            return reply(`${how} ${category} (\`${category.id}\`). Tickets claimed by **${dealer.label}** (\`${dealer.id}\`) will move there.`);
        }

        if (action === 'unmap') {
            const dealer = await resolveDealer(interaction);
            if (dealer.error) return reply(dealer.error);
            const result = await Store.updateOne({ _id: interaction.guildId }, { $pull: { sellers: { userId: dealer.id } } });
            return reply(result.modifiedCount
                ? `Removed **${dealer.label}** (\`${dealer.id}\`)’s mapping. The category itself was left in place.`
                : `**${dealer.label}** (\`${dealer.id}\`) had no mapping.`);
        }

        const config = await Store.findById(interaction.guildId).lean();
        if (action === 'limit') {
        const max = interaction.options.getInteger('max', true);
        await Store.updateOne({ _id: interaction.guildId }, { $set: { maxTicketsPerDealer: max } }, { upsert: true });
        return reply(`Dealers can now hold up to **${max}** tickets in their category. Extra claims stay in the open-ticket category with a notice.`);
    }

    const routes = (config?.sellers || []).map(item => `<@${item.userId}> (\`${item.userId}\`) → <#${item.categoryId}> (\`${item.categoryId}\`)`);
        return reply(`**Automatic ticket routing**\nOpen-ticket category: ${config?.sourceCategoryId ? `<#${config.sourceCategoryId}> (\`${config.sourceCategoryId}\`)` : 'not set'}\n${routes.length ? routes.join('\n') : 'No dealer mappings configured.'}\nTicket limit per dealer: **${config?.maxTicketsPerDealer || 10}**`);
}
