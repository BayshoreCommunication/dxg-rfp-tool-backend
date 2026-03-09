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
const smsSchema = new mongoose_1.Schema({
    type: {
        type: String,
        enum: ["single", "bulk", "exam", "fee", "attendance", "custom"],
        required: [true, "SMS type is required"],
        index: true,
    },
    message: {
        type: String,
        required: [true, "SMS message is required"],
    },
    recipients: [
        {
            mobileNumber: {
                type: String,
                required: true,
            },
            name: {
                type: String,
            },
            studentId: {
                type: String,
            },
            admissionId: {
                type: mongoose_1.Schema.Types.ObjectId,
                ref: "Admission",
            },
            status: {
                type: String,
                enum: ["pending", "sent", "failed", "delivered"],
                default: "pending",
            },
            sentAt: {
                type: Date,
            },
            deliveredAt: {
                type: Date,
            },
            error: {
                type: String,
            },
        },
    ],
    senderId: {
        type: String,
        required: [true, "Sender ID is required"],
        default: "Random",
    },
    apiKey: {
        type: String,
        // Don't store in production, use from env
    },
    examId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Exam",
        index: true,
    },
    feeId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Fee",
        index: true,
    },
    admissionId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Admission",
        index: true,
    },
    totalRecipients: {
        type: Number,
        required: true,
        default: 0,
    },
    sentCount: {
        type: Number,
        default: 0,
    },
    failedCount: {
        type: Number,
        default: 0,
    },
    deliveredCount: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ["pending", "sent", "failed", "delivered"],
        default: "pending",
        index: true,
    },
    metadata: {
        type: mongoose_1.Schema.Types.Mixed,
        default: {},
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
// Indexes for efficient queries
smsSchema.index({ type: 1, status: 1 });
smsSchema.index({ createdAt: -1 });
smsSchema.index({ examId: 1 });
smsSchema.index({ feeId: 1 });
smsSchema.index({ admissionId: 1 });
smsSchema.index({ "recipients.mobileNumber": 1 });
const SMS = mongoose_1.default.model("SMS", smsSchema);
exports.default = SMS;
//# sourceMappingURL=sms.js.map