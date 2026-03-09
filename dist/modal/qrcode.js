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
const qrCodeSchema = new mongoose_1.Schema({
    name: {
        type: String,
        required: [true, "QR code name is required"],
        trim: true,
    },
    type: {
        type: String,
        enum: ["student", "exam", "admission", "custom", "url", "text"],
        required: [true, "QR code type is required"],
        index: true,
    },
    content: {
        type: String,
        required: [true, "QR code content is required"],
        trim: true,
    },
    description: {
        type: String,
        trim: true,
    },
    studentId: {
        type: String,
        trim: true,
        index: true,
    },
    admissionId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Admission",
        index: true,
    },
    examId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Exam",
        index: true,
    },
    expiresAt: {
        type: Date,
        index: true,
    },
    isActive: {
        type: Boolean,
        default: true,
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
qrCodeSchema.index({ type: 1, isActive: 1 });
qrCodeSchema.index({ createdAt: -1 });
qrCodeSchema.index({ expiresAt: 1 });
qrCodeSchema.index({ admissionId: 1, isActive: 1 });
qrCodeSchema.index({ examId: 1, isActive: 1 });
qrCodeSchema.index({ studentId: 1, isActive: 1 });
// Text search index for name and content
qrCodeSchema.index({ name: "text", content: "text", description: "text" });
const QRCode = mongoose_1.default.model("QRCode", qrCodeSchema);
exports.default = QRCode;
//# sourceMappingURL=qrcode.js.map