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
const feeSchema = new mongoose_1.Schema({
    admissionId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Admission",
        required: [true, "Admission ID is required"],
        index: true,
    },
    studentId: {
        type: String,
        trim: true,
        index: true,
    },
    studentName: {
        type: String,
        required: [true, "Student name is required"],
        trim: true,
    },
    monthlyFee: {
        type: Number,
        required: [true, "Monthly fee is required"],
        min: [0, "Monthly fee cannot be negative"],
    },
    amountPaid: {
        type: Number,
        default: 0,
        min: [0, "Amount paid cannot be negative"],
    },
    amountDue: {
        type: Number,
        default: function () {
            return this.monthlyFee - (this.amountPaid || 0);
        },
        min: [0, "Amount due cannot be negative"],
    },
    status: {
        type: String,
        enum: ["pending", "paid", "overdue", "partial"],
        default: "pending",
        index: true,
    },
    paymentDate: {
        type: Date,
    },
    dueDate: {
        type: Date,
        required: [true, "Due date is required"],
        index: true,
    },
    paymentMethod: {
        type: String,
        enum: ["cash", "bank", "mobile_banking", "other"],
    },
    transactionId: {
        type: String,
        trim: true,
    },
    paymentSmsSent: {
        type: Boolean,
        default: false,
    },
    paymentSmsSentAt: {
        type: Date,
    },
    reminderSmsSent: {
        type: Boolean,
        default: false,
    },
    reminderSmsSentAt: {
        type: Date,
    },
    overdueSmsSent: {
        type: Boolean,
        default: false,
    },
    overdueSmsSentAt: {
        type: Date,
    },
    month: {
        type: Number,
        required: [true, "Month is required"],
        min: [1, "Month must be between 1 and 12"],
        max: [12, "Month must be between 1 and 12"],
        index: true,
    },
    year: {
        type: Number,
        required: [true, "Year is required"],
        min: [2000, "Year must be valid"],
        index: true,
    },
    notes: {
        type: String,
        trim: true,
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
// Calculate amountDue before saving
feeSchema.pre("save", function (next) {
    this.amountDue = this.monthlyFee - (this.amountPaid || 0);
    // Update status based on payment
    if (this.amountPaid >= this.monthlyFee) {
        this.status = "paid";
    }
    else if (this.amountPaid > 0) {
        this.status = "partial";
    }
    else {
        // Check if overdue
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dueDate = new Date(this.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        if (dueDate < today) {
            this.status = "overdue";
        }
        else {
            this.status = "pending";
        }
    }
    next();
});
// Compound index to ensure one fee record per student per month/year
feeSchema.index({ admissionId: 1, month: 1, year: 1 }, { unique: true });
// Indexes for queries
feeSchema.index({ dueDate: -1 });
feeSchema.index({ status: 1, dueDate: -1 });
feeSchema.index({ studentId: 1, year: 1, month: -1 });
feeSchema.index({ year: 1, month: 1 });
const Fee = mongoose_1.default.model("Fee", feeSchema);
exports.default = Fee;
//# sourceMappingURL=fee.js.map