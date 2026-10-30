// Ticket panels: the look, form, access and support roles for each panel.
// %user% / %username% / %id% placeholders work in welcome text and naming.
const cfg = require('./config');

const ROLE = cfg.roles;

const PANELS = {
    robux: {
        key: 'robux',
        channelId: cfg.channels.robuxPanel,
        title: 'Robux Shop',
        colour: 16759813,
        content: [
            'Open a ticket to buy Robux.',
            '',
            '**Methods:** Group Funds · In-game Gift · Plus Transfer',
            '**Payment:** PayPal, crypto, Wise, UPI and more, just ask.',
            '',
            'Prices depend on the seller and the method.'
        ].join('\n'),
        imageUrl: null,
        buttonLabel: 'Open a ticket!',
        emoji: { name: '🛒' },
        categoryId: cfg.categories.robuxTickets,
        naming: 'robux-%id%',
        topic: 'Robux Shop',
        canOpen: [ROLE.dealer, ROLE.buyer1k, ROLE.member],
        support: [ROLE.dealer, ROLE.jrDealer, ROLE.helper],
        welcome: { description: 'Hey %user% !\n', colour: 0x2ecc71 },
        form: {
            title: 'Robux',
            fields: [
                { id: 'amount', label: 'Robux Amount', placeholder: '10,000', required: true, max: 255 },
                { id: 'payment', label: 'Payment Method', placeholder: 'Crypto, PayPal, Wise etc.', required: true, max: 1024 },
                { id: 'method', label: 'How will you receive it?', placeholder: 'Group Funds', required: true, max: 1024 },
                // robloxRecipient: the answer is resolved to Roblox accounts and confirmed by the buyer in-ticket.
                { id: 'recipient', label: 'Roblox user that is receiving the R$:', placeholder: 'Builderman', required: true, max: 1024, robloxRecipient: true },
                { id: 'billing', label: 'Billing Name and Email Address', placeholder: 'e.g. John D.  john@example.com', required: true, max: 255 }
            ]
        },
        showClaimButton: false,
        usersCanClose: false,
        closeConfirmation: true,
        feedback: true,
        closeOnLeave: true,
        disabled: false
    },
    marketplace: {
        key: 'marketplace',
        channelId: cfg.channels.marketplacePanel,
        title: 'Marketplace Support',
        colour: 16051211,
        content: 'You may open a ticket for: \n- Support\n- Middleman requests\n- Suspicious users or trades\n- Scams\n\nPlease don’t:\n- Waste time\n- Troll in tickets',
        imageUrl: null,
        buttonLabel: 'Open a ticket!',
        emoji: { name: '🛟' },
        categoryId: cfg.categories.marketplaceTickets,
        naming: 'support-%username%',
        topic: 'Marketplace Support',
        canOpen: [ROLE.buyer1k, ROLE.member],
        support: [ROLE.dealer, ROLE.helper, ROLE.marketplaceSupport, ROLE.middleman],
        welcome: { description: 'Thank you for contacting support.\nPlease describe your issue and wait for a response.', colour: 0x2ecc71 },
        form: {
            title: 'Marketplace Support',
            fields: [
                { id: 'issue', label: 'Describe your issue:', placeholder: 'Scammed, Fake Trades, Report User, etc.', required: true, max: 255, paragraph: true },
                { id: 'users', label: 'Users involved (if any):', placeholder: 'User IDs or @mentions', required: false, max: 255 }
            ]
        },
        showClaimButton: false,
        usersCanClose: false,
        closeConfirmation: true,
        feedback: true,
        closeOnLeave: true,
        disabled: true
    }
};

const SETTINGS = {
    guildId: cfg.guildId,
    transcriptChannelId: cfg.channels.transcripts,
    perUserLimit: cfg.tickets.perUserLimit,
    firstNumber: cfg.tickets.firstNumber
};

module.exports = { ROLE, PANELS, SETTINGS };
