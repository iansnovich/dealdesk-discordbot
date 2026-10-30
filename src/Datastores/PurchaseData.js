const mongoose = require("mongoose");

const purchaseLogSchema = new mongoose.Schema({
    user: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true },
    seller: { type: String },
    timestamp: { type: Date, default: Date.now }
});

const claimLogSchema = new mongoose.Schema({
    user: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

const PurchaseData = mongoose.model("PurchaseData", purchaseLogSchema);
const ClaimData = mongoose.model("ClaimData", claimLogSchema);

module.exports = { PurchaseData, ClaimData };