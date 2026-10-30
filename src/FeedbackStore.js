const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // Discord guild ID
    channelId: { type: String, required: true },
    panelMessageId: String,
    enabled: { type: Boolean, default: true },
    configuredBy: { type: String, required: true }
}, { timestamps: true, bufferCommands: false });

const entrySchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true }, // retained internally, including anonymous submissions
    anonymous: { type: Boolean, default: false },
    rating: { type: Number, required: true, min: 1, max: 5 },
    category: { type: String, enum: ['review', 'suggestion', 'issue', 'praise', 'other'] }, // optional for older feedback records
    text: { type: String, required: true, maxlength: 1000 },
    channelId: String,
    messageId: String,
    deliveryStatus: { type: String, enum: ['pending', 'posted', 'failed'], default: 'pending' }
}, { timestamps: true, bufferCommands: false });
entrySchema.index({ guildId: 1, userId: 1, createdAt: -1 });

const cooldownSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // guildId:userId
    expiresAt: { type: Date, required: true, index: true },
    token: { type: String, required: true }
}, { timestamps: true, bufferCommands: false });

const FeedbackConfig = mongoose.models.FeedbackConfig || mongoose.model('FeedbackConfig', configSchema);
const FeedbackEntry = mongoose.models.FeedbackEntry || mongoose.model('FeedbackEntry', entrySchema);
const FeedbackCooldown = mongoose.models.FeedbackCooldown || mongoose.model('FeedbackCooldown', cooldownSchema);

module.exports = { FeedbackConfig, FeedbackEntry, FeedbackCooldown };
