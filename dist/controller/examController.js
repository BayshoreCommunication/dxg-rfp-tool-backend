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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExamStats = exports.sendExamResultSMS = exports.getExamResults = exports.createBatchExamResults = exports.createExamResult = exports.sendExamScheduleSMS = exports.deleteExam = exports.updateExam = exports.getExamById = exports.getExams = exports.createExam = void 0;
const admission_1 = __importDefault(require("../modal/admission"));
const exam_1 = __importStar(require("../modal/exam"));
// Helper function to send SMS (placeholder - integrate with your SMS service)
async function sendSMS(mobileNumbers, message) {
    // TODO: Integrate with your SMS service provider
    console.log(`Sending SMS to ${mobileNumbers.join(", ")}: ${message}`);
    // Simulate SMS sending
    return {
        success: true,
        sentTo: mobileNumbers,
    };
}
// Create exam
const createExam = async (req, res) => {
    try {
        const { examName, examType, subject, class: examClass, batchName, description, examDate, examTime, duration, } = req.body;
        if (!examName || !examType || !subject || !examClass || !examDate || !examTime) {
            res.status(400).json({
                success: false,
                message: "Please provide all required fields",
            });
            return;
        }
        const exam = await exam_1.default.create({
            examName,
            examType,
            subject,
            class: examClass,
            batchName,
            description,
            examDate: new Date(examDate),
            examTime,
            duration: duration ? Number(duration) : undefined,
            status: "scheduled",
            createdBy: req.user?.userId,
        });
        res.status(201).json({
            success: true,
            message: "Exam created successfully",
            data: exam,
        });
    }
    catch (error) {
        console.error("Create exam error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating exam",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createExam = createExam;
// Get exams
const getExams = async (req, res) => {
    try {
        const { page = "1", limit = "50", class: classFilter, batchName, subject, examType, status, startDate, endDate, } = req.query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const skip = (pageNum - 1) * limitNum;
        const query = {};
        if (classFilter)
            query.class = classFilter;
        if (batchName)
            query.batchName = batchName;
        if (subject)
            query.subject = subject;
        if (examType)
            query.examType = examType;
        if (status)
            query.status = status;
        if (startDate || endDate) {
            query.examDate = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                query.examDate.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.examDate.$lte = end;
            }
        }
        const [exams, total] = await Promise.all([
            exam_1.default.find(query)
                .populate("createdBy", "name email")
                .populate("updatedBy", "name email")
                .sort({ examDate: -1, createdAt: -1 })
                .skip(skip)
                .limit(limitNum),
            exam_1.default.countDocuments(query),
        ]);
        res.status(200).json({
            success: true,
            data: exams,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages: Math.ceil(total / limitNum),
                hasNext: skip + limitNum < total,
                hasPrev: pageNum > 1,
            },
        });
    }
    catch (error) {
        console.error("Get exams error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching exams",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getExams = getExams;
// Get single exam by ID
const getExamById = async (req, res) => {
    try {
        const { id } = req.params;
        const exam = await exam_1.default.findById(id)
            .populate("createdBy", "name email")
            .populate("updatedBy", "name email");
        if (!exam) {
            res.status(404).json({
                success: false,
                message: "Exam not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            data: exam,
        });
    }
    catch (error) {
        console.error("Get exam by ID error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching exam",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getExamById = getExamById;
// Update exam
const updateExam = async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;
        if (updateData.examDate) {
            updateData.examDate = new Date(updateData.examDate);
        }
        const exam = await exam_1.default.findByIdAndUpdate(id, { ...updateData, updatedBy: req.user?.userId }, { new: true, runValidators: true });
        if (!exam) {
            res.status(404).json({
                success: false,
                message: "Exam not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "Exam updated successfully",
            data: exam,
        });
    }
    catch (error) {
        console.error("Update exam error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating exam",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updateExam = updateExam;
// Delete exam
const deleteExam = async (req, res) => {
    try {
        const { id } = req.params;
        // Also delete all related exam results
        await exam_1.ExamResult.deleteMany({ examId: id });
        const exam = await exam_1.default.findByIdAndDelete(id);
        if (!exam) {
            res.status(404).json({
                success: false,
                message: "Exam not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "Exam deleted successfully",
        });
    }
    catch (error) {
        console.error("Delete exam error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting exam",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteExam = deleteExam;
// Send exam schedule SMS to parents
const sendExamScheduleSMS = async (req, res) => {
    try {
        const { examId } = req.body;
        if (!examId) {
            res.status(400).json({
                success: false,
                message: "Exam ID is required",
            });
            return;
        }
        const exam = await exam_1.default.findById(examId);
        if (!exam) {
            res.status(404).json({
                success: false,
                message: "Exam not found",
            });
            return;
        }
        // Get all students for this exam (by class and optionally batch)
        const admissionQuery = {
            class: exam.class,
            status: "active",
        };
        if (exam.batchName) {
            admissionQuery.batchName = exam.batchName;
        }
        const admissions = await admission_1.default.find(admissionQuery);
        if (admissions.length === 0) {
            res.status(404).json({
                success: false,
                message: "No students found for this exam",
            });
            return;
        }
        // Prepare SMS message
        const examDateStr = new Date(exam.examDate).toLocaleDateString("bn-BD", {
            year: "numeric",
            month: "long",
            day: "numeric",
        });
        const message = `পরীক্ষার সময়সূচী: ${exam.examName}\nবিষয়: ${exam.subject}\nতারিখ: ${examDateStr}\nসময়: ${exam.examTime}\nক্লাস: ${exam.class}`;
        const results = [];
        const errors = [];
        for (const admission of admissions) {
            if (!admission.alarmMobile || admission.alarmMobile.length === 0) {
                errors.push({
                    studentId: admission.studentId,
                    studentName: admission.studentName,
                    error: "No mobile numbers configured",
                });
                continue;
            }
            try {
                const smsResult = await sendSMS(admission.alarmMobile, message);
                if (smsResult.success) {
                    results.push({
                        studentId: admission.studentId,
                        studentName: admission.studentName,
                        sentTo: smsResult.sentTo,
                    });
                }
            }
            catch (error) {
                errors.push({
                    studentId: admission.studentId,
                    studentName: admission.studentName,
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            }
        }
        // Update exam to mark SMS as sent
        if (results.length > 0) {
            exam.scheduleSmsSent = true;
            exam.scheduleSmsSentAt = new Date();
            await exam.save();
        }
        res.status(200).json({
            success: true,
            message: `SMS sent to ${results.length} parent(s)`,
            data: {
                sent: results,
                errors: errors.length > 0 ? errors : undefined,
            },
        });
    }
    catch (error) {
        console.error("Send exam schedule SMS error:", error);
        res.status(500).json({
            success: false,
            message: "Error sending exam schedule SMS",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.sendExamScheduleSMS = sendExamScheduleSMS;
// Create exam result
const createExamResult = async (req, res) => {
    try {
        const { examId, admissionId, marks, totalMarks, grade, present, notes, } = req.body;
        if (!examId || !admissionId || marks === undefined || !totalMarks) {
            res.status(400).json({
                success: false,
                message: "Exam ID, Admission ID, marks, and total marks are required",
            });
            return;
        }
        // Get exam and admission details
        const [exam, admission] = await Promise.all([
            exam_1.default.findById(examId),
            admission_1.default.findById(admissionId),
        ]);
        if (!exam) {
            res.status(404).json({
                success: false,
                message: "Exam not found",
            });
            return;
        }
        if (!admission) {
            res.status(404).json({
                success: false,
                message: "Admission not found",
            });
            return;
        }
        const percentage = (Number(marks) / Number(totalMarks)) * 100;
        // Check if result already exists
        const existingResult = await exam_1.ExamResult.findOne({
            examId,
            admissionId,
        });
        let result;
        let absentSmsSent = false;
        if (existingResult) {
            // Update existing result
            existingResult.marks = Number(marks);
            existingResult.totalMarks = Number(totalMarks);
            existingResult.percentage = percentage;
            existingResult.grade = grade;
            existingResult.present = present !== undefined ? present : true;
            existingResult.notes = notes;
            existingResult.updatedBy = req.user?.userId;
            result = await existingResult.save();
        }
        else {
            // Create new result
            result = await exam_1.ExamResult.create({
                examId,
                examName: exam.examName,
                admissionId,
                studentId: admission.studentId,
                studentName: admission.studentName,
                marks: Number(marks),
                totalMarks: Number(totalMarks),
                percentage,
                grade,
                present: present !== undefined ? present : true,
                notes,
                createdBy: req.user?.userId,
            });
        }
        // If absent, send SMS
        if (!result.present && !result.absentSmsSent && admission.alarmMobile && admission.alarmMobile.length > 0) {
            const examDateStr = new Date(exam.examDate).toLocaleDateString("bn-BD");
            const message = `${admission.studentName} (${admission.studentId || "N/A"}) পরীক্ষায় অনুপস্থিত - ${exam.examName} - তারিখ: ${examDateStr}`;
            const smsResult = await sendSMS(admission.alarmMobile, message);
            if (smsResult.success) {
                result.absentSmsSent = true;
                result.absentSmsSentAt = new Date();
                await result.save();
                absentSmsSent = true;
            }
        }
        res.status(200).json({
            success: true,
            message: "Exam result created/updated successfully",
            data: result,
            absentSmsSent,
        });
    }
    catch (error) {
        console.error("Create exam result error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating exam result",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createExamResult = createExamResult;
// Create batch exam results
const createBatchExamResults = async (req, res) => {
    try {
        const { examId, results } = req.body; // results: [{ admissionId, marks, totalMarks, grade, present, notes }]
        if (!examId || !Array.isArray(results) || results.length === 0) {
            res.status(400).json({
                success: false,
                message: "Exam ID and results array are required",
            });
            return;
        }
        const exam = await exam_1.default.findById(examId);
        if (!exam) {
            res.status(404).json({
                success: false,
                message: "Exam not found",
            });
            return;
        }
        const createdResults = [];
        const errors = [];
        for (const resultData of results) {
            try {
                const { admissionId, marks, totalMarks, grade, present, notes } = resultData;
                if (!admissionId || marks === undefined || !totalMarks) {
                    errors.push({
                        admissionId,
                        error: "Admission ID, marks, and total marks are required",
                    });
                    continue;
                }
                const admission = await admission_1.default.findById(admissionId);
                if (!admission) {
                    errors.push({
                        admissionId,
                        error: "Admission not found",
                    });
                    continue;
                }
                const percentage = (Number(marks) / Number(totalMarks)) * 100;
                const existingResult = await exam_1.ExamResult.findOne({
                    examId,
                    admissionId,
                });
                let result;
                let absentSmsSent = false;
                if (existingResult) {
                    existingResult.marks = Number(marks);
                    existingResult.totalMarks = Number(totalMarks);
                    existingResult.percentage = percentage;
                    existingResult.grade = grade;
                    existingResult.present = present !== undefined ? present : true;
                    existingResult.notes = notes;
                    existingResult.updatedBy = req.user?.userId;
                    result = await existingResult.save();
                }
                else {
                    result = await exam_1.ExamResult.create({
                        examId,
                        examName: exam.examName,
                        admissionId,
                        studentId: admission.studentId,
                        studentName: admission.studentName,
                        marks: Number(marks),
                        totalMarks: Number(totalMarks),
                        percentage,
                        grade,
                        present: present !== undefined ? present : true,
                        notes,
                        createdBy: req.user?.userId,
                    });
                }
                // If absent, send SMS
                if (!result.present && !result.absentSmsSent && admission.alarmMobile && admission.alarmMobile.length > 0) {
                    const examDateStr = new Date(exam.examDate).toLocaleDateString("bn-BD");
                    const message = `${admission.studentName} (${admission.studentId || "N/A"}) পরীক্ষায় অনুপস্থিত - ${exam.examName} - তারিখ: ${examDateStr}`;
                    const smsResult = await sendSMS(admission.alarmMobile, message);
                    if (smsResult.success) {
                        result.absentSmsSent = true;
                        result.absentSmsSentAt = new Date();
                        await result.save();
                        absentSmsSent = true;
                    }
                }
                createdResults.push({
                    admissionId,
                    success: true,
                    result,
                    absentSmsSent,
                });
            }
            catch (error) {
                errors.push({
                    admissionId: resultData.admissionId,
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            }
        }
        res.status(200).json({
            success: true,
            message: `Exam results created/updated for ${createdResults.length} student(s)`,
            data: createdResults,
            errors: errors.length > 0 ? errors : undefined,
        });
    }
    catch (error) {
        console.error("Create batch exam results error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating batch exam results",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createBatchExamResults = createBatchExamResults;
// Get exam results
const getExamResults = async (req, res) => {
    try {
        const { examId, admissionId, studentId, page = "1", limit = "50", } = req.query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const skip = (pageNum - 1) * limitNum;
        const query = {};
        if (examId)
            query.examId = examId;
        if (admissionId)
            query.admissionId = admissionId;
        if (studentId)
            query.studentId = studentId;
        const [results, total] = await Promise.all([
            exam_1.ExamResult.find(query)
                .populate("examId", "examName examDate subject")
                .populate("admissionId", "studentName studentId class batchName")
                .populate("createdBy", "name email")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum),
            exam_1.ExamResult.countDocuments(query),
        ]);
        res.status(200).json({
            success: true,
            data: results,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages: Math.ceil(total / limitNum),
                hasNext: skip + limitNum < total,
                hasPrev: pageNum > 1,
            },
        });
    }
    catch (error) {
        console.error("Get exam results error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching exam results",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getExamResults = getExamResults;
// Send exam result SMS
const sendExamResultSMS = async (req, res) => {
    try {
        const { examId, admissionId, studentId } = req.body;
        if (!examId) {
            res.status(400).json({
                success: false,
                message: "Exam ID is required",
            });
            return;
        }
        const exam = await exam_1.default.findById(examId);
        if (!exam) {
            res.status(404).json({
                success: false,
                message: "Exam not found",
            });
            return;
        }
        // Build query
        const query = { examId };
        if (admissionId) {
            query.admissionId = admissionId;
        }
        else if (studentId) {
            query.studentId = studentId;
        }
        const results = await exam_1.ExamResult.find(query).populate("admissionId");
        if (results.length === 0) {
            res.status(404).json({
                success: false,
                message: "No exam results found",
            });
            return;
        }
        const sentResults = [];
        const errors = [];
        for (const result of results) {
            const admission = result.admissionId;
            if (!admission.alarmMobile || admission.alarmMobile.length === 0) {
                errors.push({
                    studentId: result.studentId,
                    studentName: result.studentName,
                    error: "No mobile numbers configured",
                });
                continue;
            }
            if (result.resultSmsSent) {
                errors.push({
                    studentId: result.studentId,
                    studentName: result.studentName,
                    error: "SMS already sent",
                });
                continue;
            }
            try {
                const examDateStr = new Date(exam.examDate).toLocaleDateString("bn-BD");
                const message = `${result.studentName} (${result.studentId || "N/A"}) - ${exam.examName} ফলাফল:\nমার্ক: ${result.marks}/${result.totalMarks}\nশতকরা: ${result.percentage.toFixed(2)}%\n${result.grade ? `গ্রেড: ${result.grade}` : ""}\nতারিখ: ${examDateStr}`;
                const smsResult = await sendSMS(admission.alarmMobile, message);
                if (smsResult.success) {
                    result.resultSmsSent = true;
                    result.resultSmsSentAt = new Date();
                    await result.save();
                    sentResults.push({
                        studentId: result.studentId,
                        studentName: result.studentName,
                        sentTo: smsResult.sentTo,
                    });
                }
            }
            catch (error) {
                errors.push({
                    studentId: result.studentId,
                    studentName: result.studentName,
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            }
        }
        // Update exam to mark result SMS as sent
        if (sentResults.length > 0) {
            exam.resultSmsSent = true;
            exam.resultSmsSentAt = new Date();
            await exam.save();
        }
        res.status(200).json({
            success: true,
            message: `Result SMS sent to ${sentResults.length} parent(s)`,
            data: {
                sent: sentResults,
                errors: errors.length > 0 ? errors : undefined,
            },
        });
    }
    catch (error) {
        console.error("Send exam result SMS error:", error);
        res.status(500).json({
            success: false,
            message: "Error sending exam result SMS",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.sendExamResultSMS = sendExamResultSMS;
// Get exam statistics
const getExamStats = async (req, res) => {
    try {
        const { examId } = req.query;
        if (!examId) {
            res.status(400).json({
                success: false,
                message: "Exam ID is required",
            });
            return;
        }
        const [total, present, absent, passed, failed] = await Promise.all([
            exam_1.ExamResult.countDocuments({ examId }),
            exam_1.ExamResult.countDocuments({ examId, present: true }),
            exam_1.ExamResult.countDocuments({ examId, present: false }),
            exam_1.ExamResult.countDocuments({ examId, percentage: { $gte: 40 } }),
            exam_1.ExamResult.countDocuments({ examId, percentage: { $lt: 40 } }),
        ]);
        res.status(200).json({
            success: true,
            data: {
                total,
                present,
                absent,
                passed,
                failed,
                passPercentage: total > 0 ? ((passed / total) * 100).toFixed(2) : "0.00",
                averagePercentage: total > 0 ? "0.00" : "0.00", // Calculate from actual results
            },
        });
    }
    catch (error) {
        console.error("Get exam stats error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching exam statistics",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getExamStats = getExamStats;
//# sourceMappingURL=examController.js.map