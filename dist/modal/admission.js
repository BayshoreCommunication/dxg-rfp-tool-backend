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
const admissionSchema = new mongoose_1.Schema({
    studentName: {
        type: String,
        required: [true, "Student name is required"],
        trim: true,
    },
    fatherName: {
        type: String,
        required: [true, "Father's name is required"],
        trim: true,
    },
    motherName: {
        type: String,
        required: [true, "Mother's name is required"],
        trim: true,
    },
    schoolName: {
        type: String,
        required: [true, "School name is required"],
        trim: true,
    },
    fatherMobile: {
        type: String,
        required: [true, "Father's mobile number is required"],
        trim: true,
    },
    motherMobile: {
        type: String,
        trim: true,
    },
    studentMobile: {
        type: String,
        trim: true,
    },
    class: {
        type: String,
        required: [true, "Class is required"],
        trim: true,
    },
    subjects: {
        type: [String],
        required: [true, "At least one subject is required"],
        validate: {
            validator: (v) => v.length > 0,
            message: "At least one subject is required",
        },
    },
    batchName: {
        type: String,
        required: [true, "Batch name is required"],
        trim: true,
    },
    batchTime: {
        type: String,
        required: [true, "Batch time is required"],
        trim: true,
    },
    admissionDate: {
        type: Date,
        required: [true, "Admission date is required"],
        default: Date.now,
    },
    monthlyFee: {
        type: Number,
        required: [true, "Monthly fee is required"],
        min: [0, "Monthly fee cannot be negative"],
    },
    studentSignature: {
        type: String,
    },
    directorSignature: {
        type: String,
    },
    studentId: {
        type: String,
        unique: true,
        sparse: true,
        index: true,
    },
    status: {
        type: String,
        enum: ["active", "inactive", "completed"],
        default: "active",
    },
    notes: {
        type: String,
        trim: true,
    },
    alarmMobile: {
        type: [String],
        default: [],
    },
    smsHistory: {
        type: [String],
        default: [],
    },
    emailHistory: {
        type: [String],
        default: [],
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
// Generate student ID before saving
admissionSchema.pre("save", async function (next) {
    try {
        // Only generate if it's missing
        if (!this.studentId) {
            // Generate student ID: ADM-YYYY-MMDD-XXXX (e.g., ADM-2025-0101-0001)
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            // Get count of admissions created today (between start and end of day)
            const startOfDay = new Date(year, now.getMonth(), now.getDate(), 0, 0, 0, 0);
            const endOfDay = new Date(year, now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
            const AdmissionModel = this.constructor;
            const count = await AdmissionModel.countDocuments({
                createdAt: { $gte: startOfDay, $lt: endOfDay },
            });
            const sequence = String(count + 1).padStart(4, "0");
            this.studentId = `ADM-${year}-${month}${day}-${sequence}`;
        }
        next();
    }
    catch (err) {
        next(err);
    }
});
// Index for search
admissionSchema.index({
    studentName: "text",
    fatherName: "text",
    motherName: "text",
    studentId: "text",
});
admissionSchema.index({ class: 1, batchName: 1, status: 1 });
admissionSchema.index({ admissionDate: -1 });
const Admission = mongoose_1.default.model("Admission", admissionSchema);
exports.default = Admission;
//# sourceMappingURL=admission.js.map