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
exports.ExamResult = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const examSchema = new mongoose_1.Schema({
    examName: {
        type: String,
        required: [true, "Exam name is required"],
        trim: true,
    },
    examType: {
        type: String,
        enum: ["quiz", "midterm", "final", "assignment", "other"],
        required: [true, "Exam type is required"],
    },
    subject: {
        type: String,
        required: [true, "Subject is required"],
        trim: true,
    },
    class: {
        type: String,
        required: [true, "Class is required"],
        trim: true,
    },
    batchName: {
        type: String,
        trim: true,
    },
    description: {
        type: String,
        trim: true,
    },
    examDate: {
        type: Date,
        required: [true, "Exam date is required"],
        index: true,
    },
    examTime: {
        type: String,
        required: [true, "Exam time is required"],
        trim: true,
    },
    duration: {
        type: Number,
        min: [1, "Duration must be at least 1 minute"],
    },
    status: {
        type: String,
        enum: ["scheduled", "completed", "cancelled"],
        default: "scheduled",
    },
    scheduleSmsSent: {
        type: Boolean,
        default: false,
    },
    scheduleSmsSentAt: {
        type: Date,
    },
    resultSmsSent: {
        type: Boolean,
        default: false,
    },
    resultSmsSentAt: {
        type: Date,
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
const examResultSchema = new mongoose_1.Schema({
    examId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Exam",
        required: [true, "Exam ID is required"],
        index: true,
    },
    examName: {
        type: String,
        trim: true,
    },
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
    marks: {
        type: Number,
        required: [true, "Marks are required"],
        min: [0, "Marks cannot be negative"],
    },
    totalMarks: {
        type: Number,
        required: [true, "Total marks are required"],
        min: [1, "Total marks must be at least 1"],
    },
    grade: {
        type: String,
        trim: true,
    },
    percentage: {
        type: Number,
        required: [true, "Percentage is required"],
        min: [0, "Percentage cannot be negative"],
        max: [100, "Percentage cannot exceed 100"],
    },
    present: {
        type: Boolean,
        default: true,
    },
    absentSmsSent: {
        type: Boolean,
        default: false,
    },
    absentSmsSentAt: {
        type: Date,
    },
    resultSmsSent: {
        type: Boolean,
        default: false,
    },
    resultSmsSentAt: {
        type: Date,
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
// Compound index to ensure one result per student per exam
examResultSchema.index({ examId: 1, admissionId: 1 }, { unique: true });
// Indexes for queries
examSchema.index({ examDate: -1 });
examSchema.index({ class: 1, examDate: -1 });
examSchema.index({ status: 1 });
examResultSchema.index({ examId: 1, marks: -1 });
examResultSchema.index({ admissionId: 1 });
examResultSchema.index({ studentId: 1 });
const Exam = mongoose_1.default.model("Exam", examSchema);
const ExamResult = mongoose_1.default.model("ExamResult", examResultSchema);
exports.ExamResult = ExamResult;
exports.default = Exam;
//# sourceMappingURL=exam.js.map