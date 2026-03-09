"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAttendance = exports.sendAttendanceReportSMS = exports.getStudentAttendanceReport = exports.getAttendanceStats = exports.getAttendances = exports.markBatchAttendance = exports.markAttendance = void 0;
const admission_1 = __importDefault(require("../modal/admission"));
const attendance_1 = __importDefault(require("../modal/attendance"));
// Helper function to send SMS (placeholder - integrate with your SMS service)
async function sendSMS(mobileNumbers, message) {
    // TODO: Integrate with your SMS service provider
    // For now, this is a placeholder
    console.log(`Sending SMS to ${mobileNumbers.join(", ")}: ${message}`);
    // Simulate SMS sending
    return {
        success: true,
        sentTo: mobileNumbers,
    };
}
// Mark attendance for a single student
const markAttendance = async (req, res) => {
    try {
        const { admissionId, date, status, notes } = req.body;
        const userId = req.user?.userId;
        if (!admissionId || !date || !status) {
            res.status(400).json({
                success: false,
                message: "Admission ID, date, and status are required",
            });
            return;
        }
        if (!["present", "absent"].includes(status)) {
            res.status(400).json({
                success: false,
                message: "Status must be 'present' or 'absent'",
            });
            return;
        }
        // Get admission details
        const admission = await admission_1.default.findById(admissionId);
        if (!admission) {
            res.status(404).json({
                success: false,
                message: "Admission not found",
            });
            return;
        }
        // Parse date
        const attendanceDate = new Date(date);
        attendanceDate.setHours(0, 0, 0, 0);
        // Check if attendance already exists for this date
        const existingAttendance = await attendance_1.default.findOne({
            admissionId,
            date: attendanceDate,
        });
        let attendance;
        let smsSent = false;
        let smsRecipients = [];
        if (existingAttendance) {
            // Update existing attendance
            existingAttendance.status = status;
            existingAttendance.notes = notes;
            existingAttendance.markedBy = userId;
            // If status changed to absent and SMS not sent, send SMS
            if (status === "absent" && !existingAttendance.smsSent && admission.alarmMobile && admission.alarmMobile.length > 0) {
                const message = `${admission.studentName} (${admission.studentId || "N/A"}) অনুপস্থিত - তারিখ: ${attendanceDate.toLocaleDateString("bn-BD")}`;
                const smsResult = await sendSMS(admission.alarmMobile, message);
                if (smsResult.success) {
                    existingAttendance.smsSent = true;
                    existingAttendance.smsSentAt = new Date();
                    existingAttendance.smsRecipients = smsResult.sentTo;
                    smsSent = true;
                    smsRecipients = smsResult.sentTo;
                }
            }
            attendance = await existingAttendance.save();
        }
        else {
            // Create new attendance
            attendance = await attendance_1.default.create({
                admissionId,
                studentId: admission.studentId,
                studentName: admission.studentName,
                date: attendanceDate,
                status,
                notes,
                markedBy: userId,
            });
            // If absent, send SMS to parents
            if (status === "absent" && admission.alarmMobile && admission.alarmMobile.length > 0) {
                const message = `${admission.studentName} (${admission.studentId || "N/A"}) অনুপস্থিত - তারিখ: ${attendanceDate.toLocaleDateString("bn-BD")}`;
                const smsResult = await sendSMS(admission.alarmMobile, message);
                if (smsResult.success) {
                    attendance.smsSent = true;
                    attendance.smsSentAt = new Date();
                    attendance.smsRecipients = smsResult.sentTo;
                    await attendance.save();
                    smsSent = true;
                    smsRecipients = smsResult.sentTo;
                }
            }
        }
        res.status(200).json({
            success: true,
            message: "Attendance marked successfully",
            data: attendance,
            smsSent,
            smsRecipients,
        });
    }
    catch (error) {
        console.error("Mark attendance error:", error);
        res.status(500).json({
            success: false,
            message: "Error marking attendance",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.markAttendance = markAttendance;
// Mark attendance for multiple students (batch)
const markBatchAttendance = async (req, res) => {
    try {
        const { date, attendances } = req.body; // attendances: [{ admissionId, status, notes }]
        const userId = req.user?.userId;
        if (!date || !Array.isArray(attendances) || attendances.length === 0) {
            res.status(400).json({
                success: false,
                message: "Date and attendances array are required",
            });
            return;
        }
        const attendanceDate = new Date(date);
        attendanceDate.setHours(0, 0, 0, 0);
        const results = [];
        const errors = [];
        for (const att of attendances) {
            try {
                const { admissionId, status, notes } = att;
                if (!admissionId || !status) {
                    errors.push({
                        admissionId,
                        error: "Admission ID and status are required",
                    });
                    continue;
                }
                // Get admission details
                const admission = await admission_1.default.findById(admissionId);
                if (!admission) {
                    errors.push({
                        admissionId,
                        error: "Admission not found",
                    });
                    continue;
                }
                // Check if attendance already exists
                const existingAttendance = await attendance_1.default.findOne({
                    admissionId,
                    date: attendanceDate,
                });
                let attendance;
                let smsSent = false;
                let smsRecipients = [];
                if (existingAttendance) {
                    existingAttendance.status = status;
                    existingAttendance.notes = notes;
                    existingAttendance.markedBy = userId;
                    if (status === "absent" && !existingAttendance.smsSent && admission.alarmMobile && admission.alarmMobile.length > 0) {
                        const message = `${admission.studentName} (${admission.studentId || "N/A"}) অনুপস্থিত - তারিখ: ${attendanceDate.toLocaleDateString("bn-BD")}`;
                        const smsResult = await sendSMS(admission.alarmMobile, message);
                        if (smsResult.success) {
                            existingAttendance.smsSent = true;
                            existingAttendance.smsSentAt = new Date();
                            existingAttendance.smsRecipients = smsResult.sentTo;
                            smsSent = true;
                            smsRecipients = smsResult.sentTo;
                        }
                    }
                    attendance = await existingAttendance.save();
                }
                else {
                    attendance = await attendance_1.default.create({
                        admissionId,
                        studentId: admission.studentId,
                        studentName: admission.studentName,
                        date: attendanceDate,
                        status,
                        notes,
                        markedBy: userId,
                    });
                    if (status === "absent" && admission.alarmMobile && admission.alarmMobile.length > 0) {
                        const message = `${admission.studentName} (${admission.studentId || "N/A"}) অনুপস্থিত - তারিখ: ${attendanceDate.toLocaleDateString("bn-BD")}`;
                        const smsResult = await sendSMS(admission.alarmMobile, message);
                        if (smsResult.success) {
                            attendance.smsSent = true;
                            attendance.smsSentAt = new Date();
                            attendance.smsRecipients = smsResult.sentTo;
                            await attendance.save();
                            smsSent = true;
                            smsRecipients = smsResult.sentTo;
                        }
                    }
                }
                results.push({
                    admissionId,
                    success: true,
                    attendance,
                    smsSent,
                    smsRecipients,
                });
            }
            catch (error) {
                errors.push({
                    admissionId: att.admissionId,
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            }
        }
        res.status(200).json({
            success: true,
            message: `Attendance marked for ${results.length} student(s)`,
            data: results,
            errors: errors.length > 0 ? errors : undefined,
        });
    }
    catch (error) {
        console.error("Mark batch attendance error:", error);
        res.status(500).json({
            success: false,
            message: "Error marking batch attendance",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.markBatchAttendance = markBatchAttendance;
// Get attendance records
const getAttendances = async (req, res) => {
    try {
        const { page = "1", limit = "50", admissionId, studentId, startDate, endDate, status, class: classFilter, batchName, } = req.query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const skip = (pageNum - 1) * limitNum;
        const query = {};
        if (admissionId) {
            query.admissionId = admissionId;
        }
        if (studentId) {
            query.studentId = studentId;
        }
        if (startDate || endDate) {
            query.date = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                query.date.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.date.$lte = end;
            }
        }
        if (status) {
            query.status = status;
        }
        // If filtering by class or batch, need to join with Admission
        if (classFilter || batchName) {
            const admissionQuery = {};
            if (classFilter)
                admissionQuery.class = classFilter;
            if (batchName)
                admissionQuery.batchName = batchName;
            const admissions = await admission_1.default.find(admissionQuery).select("_id");
            const admissionIds = admissions.map((a) => a._id);
            query.admissionId = { $in: admissionIds };
        }
        const [attendances, total] = await Promise.all([
            attendance_1.default.find(query)
                .populate("admissionId", "studentName studentId class batchName fatherMobile motherMobile alarmMobile")
                .populate("markedBy", "name email")
                .sort({ date: -1, createdAt: -1 })
                .skip(skip)
                .limit(limitNum),
            attendance_1.default.countDocuments(query),
        ]);
        res.status(200).json({
            success: true,
            data: attendances,
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
        console.error("Get attendances error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching attendances",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getAttendances = getAttendances;
// Get attendance statistics
const getAttendanceStats = async (req, res) => {
    try {
        const { admissionId, studentId, startDate, endDate, class: classFilter, batchName } = req.query;
        const query = {};
        if (admissionId) {
            query.admissionId = admissionId;
        }
        if (studentId) {
            query.studentId = studentId;
        }
        if (startDate || endDate) {
            query.date = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                query.date.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.date.$lte = end;
            }
        }
        if (classFilter || batchName) {
            const admissionQuery = {};
            if (classFilter)
                admissionQuery.class = classFilter;
            if (batchName)
                admissionQuery.batchName = batchName;
            const admissions = await admission_1.default.find(admissionQuery).select("_id");
            const admissionIds = admissions.map((a) => a._id);
            query.admissionId = { $in: admissionIds };
        }
        const [total, present, absent] = await Promise.all([
            attendance_1.default.countDocuments(query),
            attendance_1.default.countDocuments({ ...query, status: "present" }),
            attendance_1.default.countDocuments({ ...query, status: "absent" }),
        ]);
        res.status(200).json({
            success: true,
            data: {
                total,
                present,
                absent,
                presentPercentage: total > 0 ? ((present / total) * 100).toFixed(2) : "0.00",
                absentPercentage: total > 0 ? ((absent / total) * 100).toFixed(2) : "0.00",
            },
        });
    }
    catch (error) {
        console.error("Get attendance stats error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching attendance statistics",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getAttendanceStats = getAttendanceStats;
// Get weekly/monthly attendance report for a student
const getStudentAttendanceReport = async (req, res) => {
    try {
        const { admissionId, studentId, period } = req.query; // period: 'week' | 'month'
        if (!admissionId && !studentId) {
            res.status(400).json({
                success: false,
                message: "Admission ID or Student ID is required",
            });
            return;
        }
        const query = {};
        if (admissionId) {
            query.admissionId = admissionId;
        }
        if (studentId) {
            query.studentId = studentId;
        }
        const now = new Date();
        let startDate;
        let endDate = new Date(now);
        endDate.setHours(23, 59, 59, 999);
        if (period === "week") {
            // Get start of current week (Sunday)
            startDate = new Date(now);
            const day = startDate.getDay();
            const diff = startDate.getDate() - day;
            startDate.setDate(diff);
            startDate.setHours(0, 0, 0, 0);
        }
        else {
            // Default to month
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            startDate.setHours(0, 0, 0, 0);
        }
        query.date = { $gte: startDate, $lte: endDate };
        const attendances = await attendance_1.default.find(query)
            .populate("admissionId", "studentName studentId class batchName fatherMobile motherMobile alarmMobile")
            .sort({ date: -1 });
        const present = attendances.filter((a) => a.status === "present").length;
        const absent = attendances.filter((a) => a.status === "absent").length;
        const total = attendances.length;
        // Get admission for SMS sending
        const admission = await admission_1.default.findOne(admissionId ? { _id: admissionId } : { studentId });
        res.status(200).json({
            success: true,
            data: {
                period: period || "month",
                startDate,
                endDate,
                total,
                present,
                absent,
                presentPercentage: total > 0 ? ((present / total) * 100).toFixed(2) : "0.00",
                absentPercentage: total > 0 ? ((absent / total) * 100).toFixed(2) : "0.00",
                attendances,
                admission,
            },
        });
    }
    catch (error) {
        console.error("Get student attendance report error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching attendance report",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getStudentAttendanceReport = getStudentAttendanceReport;
// Send SMS for weekly/monthly report
const sendAttendanceReportSMS = async (req, res) => {
    try {
        const { admissionId, studentId, period } = req.body; // period: 'week' | 'month'
        if (!admissionId && !studentId) {
            res.status(400).json({
                success: false,
                message: "Admission ID or Student ID is required",
            });
            return;
        }
        // Get admission
        const admission = await admission_1.default.findOne(admissionId ? { _id: admissionId } : { studentId });
        if (!admission) {
            res.status(404).json({
                success: false,
                message: "Admission not found",
            });
            return;
        }
        if (!admission.alarmMobile || admission.alarmMobile.length === 0) {
            res.status(400).json({
                success: false,
                message: "No mobile numbers configured for SMS notifications",
            });
            return;
        }
        // Get attendance report
        const now = new Date();
        let startDate;
        let endDate = new Date(now);
        endDate.setHours(23, 59, 59, 999);
        if (period === "week") {
            startDate = new Date(now);
            const day = startDate.getDay();
            const diff = startDate.getDate() - day;
            startDate.setDate(diff);
            startDate.setHours(0, 0, 0, 0);
        }
        else {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            startDate.setHours(0, 0, 0, 0);
        }
        const attendances = await attendance_1.default.find({
            admissionId: admission._id,
            date: { $gte: startDate, $lte: endDate },
        });
        const present = attendances.filter((a) => a.status === "present").length;
        const absent = attendances.filter((a) => a.status === "absent").length;
        const total = attendances.length;
        // Create SMS message
        const periodText = period === "week" ? "সাপ্তাহিক" : "মাসিক";
        const message = `${admission.studentName} (${admission.studentId || "N/A"}) - ${periodText} উপস্থিতি রিপোর্ট:\nউপস্থিত: ${present} দিন\nঅনুপস্থিত: ${absent} দিন\nমোট: ${total} দিন`;
        // Send SMS
        const smsResult = await sendSMS(admission.alarmMobile, message);
        if (smsResult.success) {
            res.status(200).json({
                success: true,
                message: "Attendance report SMS sent successfully",
                data: {
                    sentTo: smsResult.sentTo,
                    period,
                    present,
                    absent,
                    total,
                },
            });
        }
        else {
            res.status(500).json({
                success: false,
                message: "Failed to send SMS",
            });
        }
    }
    catch (error) {
        console.error("Send attendance report SMS error:", error);
        res.status(500).json({
            success: false,
            message: "Error sending attendance report SMS",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.sendAttendanceReportSMS = sendAttendanceReportSMS;
// Delete attendance
const deleteAttendance = async (req, res) => {
    try {
        const { id } = req.params;
        const attendance = await attendance_1.default.findByIdAndDelete(id);
        if (!attendance) {
            res.status(404).json({
                success: false,
                message: "Attendance not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "Attendance deleted successfully",
        });
    }
    catch (error) {
        console.error("Delete attendance error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting attendance",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteAttendance = deleteAttendance;
//# sourceMappingURL=attendanceController.js.map