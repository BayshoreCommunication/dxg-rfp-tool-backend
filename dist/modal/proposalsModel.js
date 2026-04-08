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
const proposalSchema = new mongoose_1.Schema({
    userId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
    },
    status: {
        type: String,
        enum: ["draft", "submitted", "reviewed", "approved", "rejected"],
        default: "submitted",
    },
    isActive: { type: Boolean, default: true },
    isFavorite: { type: Boolean, default: false },
    isAccepted: { type: Boolean, default: false },
    isOpen: { type: Boolean, default: true },
    viewsCount: { type: Number, default: 0, min: 0 },
    templateId: {
        type: String,
        enum: ["template-one", "template-two"],
        default: "template-one",
    },
    event: {
        eventName: {
            type: String,
            required: [true, "Event name is required"],
            trim: true,
        },
        startDate: { type: String, trim: true },
        endDate: { type: String, trim: true },
        venue: { type: String, trim: true },
        attendees: { type: String, trim: true },
        eventFormat: { type: String, enum: ["In-Person", "Hybrid", "Virtual"] },
        eventType: {
            eventType: { type: String, trim: true },
            eventTypeOther: { type: String, trim: true },
        },
    },
    roomByRoom: { type: mongoose_1.Schema.Types.Mixed, default: {} },
    production: { type: mongoose_1.Schema.Types.Mixed, default: {} },
    venue: { type: mongoose_1.Schema.Types.Mixed, default: {} },
    uploads: { type: mongoose_1.Schema.Types.Mixed, default: {} },
    budget: { type: mongoose_1.Schema.Types.Mixed, default: {} },
    contact: {
        contactFirstName: {
            type: String,
            required: [true, "First name is required"],
            trim: true,
        },
        contactLastName: {
            type: String,
            required: [true, "Last name is required"],
            trim: true,
        },
        contactTitle: { type: String, trim: true },
        contactOrganization: { type: String, trim: true },
        contactEmail: {
            type: String,
            required: [true, "Contact email is required"],
            trim: true,
            lowercase: true,
        },
        contactPhone: {
            type: String,
            required: [true, "Contact phone is required"],
            trim: true,
        },
        anythingElse: { type: String, trim: true },
    },
}, {
    timestamps: true,
});
proposalSchema.index({ userId: 1, createdAt: -1 });
proposalSchema.index({ status: 1 });
proposalSchema.index({ "contact.contactEmail": 1 });
proposalSchema.index({ "event.eventName": 1 });
const Proposal = mongoose_1.default.model("Proposal", proposalSchema);
exports.default = Proposal;
//# sourceMappingURL=proposalsModel.js.map