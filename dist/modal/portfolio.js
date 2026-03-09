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
const portfolioSchema = new mongoose_1.Schema({
    appTitle: {
        type: String,
        required: [true, "App title is required"],
        trim: true,
        default: "Coaching Center",
    },
    appLogo: {
        type: String,
        trim: true,
        default: "",
    },
    appDescription: {
        type: String,
        trim: true,
    },
    appTagline: {
        type: String,
        trim: true,
    },
    favicon: {
        type: String,
        trim: true,
    },
    primaryColor: {
        type: String,
        trim: true,
        default: "#3B82F6",
    },
    secondaryColor: {
        type: String,
        trim: true,
        default: "#8B5CF6",
    },
    accentColor: {
        type: String,
        trim: true,
        default: "#10B981",
    },
    email: {
        type: String,
        trim: true,
        lowercase: true,
    },
    phone: {
        type: String,
        trim: true,
    },
    address: {
        type: String,
        trim: true,
    },
    website: {
        type: String,
        trim: true,
    },
    socialMedia: {
        facebook: { type: String, trim: true },
        twitter: { type: String, trim: true },
        instagram: { type: String, trim: true },
        linkedin: { type: String, trim: true },
        youtube: { type: String, trim: true },
    },
    metaKeywords: {
        type: String,
        trim: true,
    },
    metaDescription: {
        type: String,
        trim: true,
    },
    copyrightText: {
        type: String,
        trim: true,
        default: "© 2024 Coaching Center. All rights reserved.",
    },
    createdBy: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    updatedBy: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
    },
}, {
    timestamps: true,
});
// Indexes
portfolioSchema.index({ createdAt: -1 });
// Ensure only one portfolio document exists
portfolioSchema.statics.getPortfolio = async function () {
    let portfolio = await this.findOne();
    if (!portfolio) {
        portfolio = await this.create({
            appTitle: "Coaching Center",
            createdBy: new mongoose_1.default.Types.ObjectId(),
        });
    }
    return portfolio;
};
const Portfolio = mongoose_1.default.model("Portfolio", portfolioSchema);
exports.default = Portfolio;
//# sourceMappingURL=portfolio.js.map