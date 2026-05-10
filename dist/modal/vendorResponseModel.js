"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const mongoose_2 = require("mongoose");
const vendorDocumentSchema = new mongoose_2.Schema({
    name: { type: String, trim: true },
    url: { type: String, trim: true },
}, { _id: false });
const vendorResponseSchema = new mongoose_2.Schema({
    proposalId: {
        type: mongoose_2.Schema.Types.ObjectId,
        ref: "Proposal",
        required: [true, "Proposal id is required"],
        index: true,
    },
    proposalOwnerId: {
        type: mongoose_2.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Proposal owner id is required"],
        index: true,
    },
    proposalTitle: { type: String, trim: true, default: "" },
    vendorName: {
        type: String,
        required: [true, "Vendor name is required"],
        trim: true,
    },
    submittedBy: {
        type: String,
        required: [true, "Submitted by is required"],
        trim: true,
    },
    email: {
        type: String,
        required: [true, "Email is required"],
        trim: true,
        lowercase: true,
    },
    message: { type: String, trim: true, default: "" },
    documents: { type: [vendorDocumentSchema], default: [] },
    isRead: { type: Boolean, default: false },
    emailTrackingId: { type: String, default: null, index: true, sparse: true },
}, { timestamps: true });
vendorResponseSchema.index({ proposalOwnerId: 1, createdAt: -1 });
vendorResponseSchema.index({ proposalOwnerId: 1, isRead: 1 });
vendorResponseSchema.index({ proposalId: 1, email: 1 }, { unique: true });
vendorResponseSchema.index({ emailTrackingId: 1 }, { unique: true, sparse: true });
const VendorResponse = mongoose_1.default.model("VendorResponse", vendorResponseSchema);
exports.default = VendorResponse;
