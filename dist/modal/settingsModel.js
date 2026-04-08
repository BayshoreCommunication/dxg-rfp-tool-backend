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
const settingsSchema = new mongoose_1.Schema({
    userId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
    },
    branding: {
        brandName: { type: String, default: "", trim: true },
        linkPrefix: { type: String, default: "", trim: true },
        defaultFont: { type: String, default: "Poppins", trim: true },
        signatureColor: { type: String, default: "#2DC6F5", trim: true },
        logoFile: { type: String, default: null },
    },
    proposals: {
        proposalLanguage: { type: String, default: "English", trim: true },
        defaultCurrency: { type: String, default: "$", trim: true },
        expiryDate: { type: String, default: "None", trim: true },
        priceSeparator: { type: String, default: "NONE", trim: true },
        dateFormat: { type: String, default: "MM/DD/YYYY", trim: true },
        decimalPrecision: { type: String, default: "2", trim: true },
        contacts: {
            email: {
                enabled: { type: Boolean, default: true },
                value: { type: String, default: "", trim: true },
            },
            call: {
                enabled: { type: Boolean, default: false },
                value: { type: String, default: "", trim: true },
            },
        },
        downloadPreview: { type: String, default: "Yes", trim: true },
        teammateEmail: { type: String, default: "", trim: true },
    },
    signatures: {
        signatureType: { type: String, default: "Upload", trim: true },
        signatureImageUrl: { type: String, default: "", trim: true },
        signatureText: { type: String, default: "", trim: true },
        signatureStyle: { type: String, default: "", trim: true },
    },
}, { timestamps: true });
settingsSchema.index({ userId: 1 });
const Settings = mongoose_1.default.model("Settings", settingsSchema);
exports.default = Settings;
//# sourceMappingURL=settingsModel.js.map