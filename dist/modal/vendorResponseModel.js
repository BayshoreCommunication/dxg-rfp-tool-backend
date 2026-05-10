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
const vendorDocumentSchema = new mongoose_1.Schema({
    name: { type: String, trim: true },
    url: { type: String, trim: true },
}, { _id: false });
const vendorResponseSchema = new mongoose_1.Schema({
    proposalId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Proposal",
        required: [true, "Proposal id is required"],
        index: true,
    },
    proposalOwnerId: {
        type: mongoose_1.Schema.Types.ObjectId,
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
//# sourceMappingURL=vendorResponseModel.js.map