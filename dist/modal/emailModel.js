"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const emailRecipientSchema = new mongoose_1.Schema({
    email: {
        type: String,
        required: [true, "Recipient email is required"],
        trim: true,
        lowercase: true,
        match: [/^\S+@\S+\.\S+$/, "Please provide a valid recipient email"],
    },
    trackingId: {
        type: String,
        required: [true, "Tracking id is required"],
        trim: true,
        unique: true,
    },
    sentAt: { type: Date },
    openedAt: { type: Date },
    clickedAt: { type: Date },
    status: {
        type: String,
        enum: ["sent", "failed"],
        default: "sent",
    },
    errorMessage: { type: String, trim: true },
}, { _id: false });
const emailCampaignSchema = new mongoose_1.Schema({
    userId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "User id is required"],
        index: true,
    },
    proposalId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Proposal",
        required: [true, "Proposal id is required"],
        index: true,
    },
    proposalTitle: {
        type: String,
        required: [true, "Proposal title is required"],
        trim: true,
    },
    proposalSlug: {
        type: String,
        required: [true, "Proposal slug is required"],
        trim: true,
    },
    subject: {
        type: String,
        required: [true, "Subject is required"],
        trim: true,
    },
    message: {
        type: String,
        required: [true, "Message is required"],
        trim: true,
    },
    recipients: {
        type: [emailRecipientSchema],
        default: [],
    },
    totalRecipients: { type: Number, default: 0, min: 0 },
    sentCount: { type: Number, default: 0, min: 0 },
    openedCount: { type: Number, default: 0, min: 0 },
    clickedCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });
emailCampaignSchema.index({ userId: 1, createdAt: -1 });
emailCampaignSchema.index({ userId: 1, proposalId: 1, createdAt: -1 });
emailCampaignSchema.index({ "recipients.trackingId": 1 });
const EmailCampaign = mongoose_1.default.model("EmailCampaign", emailCampaignSchema);
exports.default = EmailCampaign;
//# sourceMappingURL=emailModel.js.map