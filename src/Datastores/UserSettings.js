const mongoose = require("mongoose");
const userSettingsSchema = new mongoose.Schema({
    user: { type: String, required: true, unique: true },
    dmDisabled: { type: Boolean, default: false },
    plusRemindersEnabled: { type: Boolean, default: false },
    plusEnabledAt: Date,
    robloxUsernames: { type: [String], default: [] }
});
module.exports = mongoose.model("UserSettings", userSettingsSchema);
