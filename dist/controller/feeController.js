"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBulkFees = exports.getFeeStats = exports.sendPaymentConfirmationSMS = exports.sendOverdueSMS = exports.sendPaymentReminderSMS = exports.deleteFee = exports.updateFee = exports.getFeeById = exports.getFees = exports.createFee = void 0;
const admission_1 = __importDefault(require("../modal/admission"));
const fee_1 = __importDefault(require("../modal/fee"));
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
// Create fee record
const createFee = async (req, res) => {
    try {
        const { admissionId, monthlyFee, dueDate, month, year, notes, } = req.body;
        if (!admissionId || !monthlyFee || !dueDate || !month || !year) {
            res.status(400).json({
                success: false,
                message: "Admission ID, monthly fee, due date, month, and year are required",
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
        // Check if fee already exists for this month/year
        const existingFee = await fee_1.default.findOne({
            admissionId,
            month: Number(month),
            year: Number(year),
        });
        if (existingFee) {
            res.status(400).json({
                success: false,
                message: "Fee record already exists for this month and year",
            });
            return;
        }
        const fee = await fee_1.default.create({
            admissionId,
            studentId: admission.studentId,
            studentName: admission.studentName,
            monthlyFee: Number(monthlyFee),
            amountPaid: 0,
            dueDate: new Date(dueDate),
            month: Number(month),
            year: Number(year),
            notes,
            status: "pending",
            createdBy: req.user?.userId,
        });
        res.status(201).json({
            success: true,
            message: "Fee record created successfully",
            data: fee,
        });
    }
    catch (error) {
        console.error("Create fee error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating fee record",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createFee = createFee;
// Get fees
const getFees = async (req, res) => {
    try {
        const { page = "1", limit = "50", admissionId, studentId, month, year, status, class: classFilter, startDate, endDate, } = req.query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const skip = (pageNum - 1) * limitNum;
        const query = {};
        if (admissionId)
            query.admissionId = admissionId;
        if (studentId)
            query.studentId = studentId;
        if (month)
            query.month = Number(month);
        if (year)
            query.year = Number(year);
        if (status)
            query.status = status;
        if (startDate || endDate) {
            query.dueDate = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                query.dueDate.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.dueDate.$lte = end;
            }
        }
        // If filtering by class, need to join with Admission
        if (classFilter) {
            const admissions = await admission_1.default.find({ class: classFilter }).select("_id");
            const admissionIds = admissions.map((a) => a._id);
            query.admissionId = { $in: admissionIds };
        }
        const [fees, total] = await Promise.all([
            fee_1.default.find(query)
                .populate("admissionId", "studentName studentId class batchName fatherMobile motherMobile alarmMobile monthlyFee")
                .populate("createdBy", "name email")
                .sort({ year: -1, month: -1, dueDate: -1 })
                .skip(skip)
                .limit(limitNum),
            fee_1.default.countDocuments(query),
        ]);
        res.status(200).json({
            success: true,
            data: fees,
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
        console.error("Get fees error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching fees",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getFees = getFees;
// Get single fee by ID
const getFeeById = async (req, res) => {
    try {
        const { id } = req.params;
        const fee = await fee_1.default.findById(id)
            .populate("admissionId", "studentName studentId class batchName fatherMobile motherMobile alarmMobile monthlyFee")
            .populate("createdBy", "name email");
        if (!fee) {
            res.status(404).json({
                success: false,
                message: "Fee not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            data: fee,
        });
    }
    catch (error) {
        console.error("Get fee by ID error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching fee",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getFeeById = getFeeById;
// Update fee (mark as paid)
const updateFee = async (req, res) => {
    try {
        const { id } = req.params;
        const { amountPaid, paymentDate, paymentMethod, transactionId, notes, sendSms, } = req.body;
        const fee = await fee_1.default.findById(id).populate("admissionId");
        if (!fee) {
            res.status(404).json({
                success: false,
                message: "Fee not found",
            });
            return;
        }
        const admission = fee.admissionId;
        // Update fee
        if (amountPaid !== undefined) {
            fee.amountPaid = Number(amountPaid);
        }
        if (paymentDate) {
            fee.paymentDate = new Date(paymentDate);
        }
        if (paymentMethod) {
            fee.paymentMethod = paymentMethod;
        }
        if (transactionId !== undefined) {
            fee.transactionId = transactionId;
        }
        if (notes !== undefined) {
            fee.notes = notes;
        }
        fee.updatedBy = req.user?.userId;
        // Status will be updated automatically by pre-save hook
        await fee.save();
        // Send payment confirmation SMS if requested and not already sent
        let paymentSmsSent = false;
        if (sendSms && fee.status === "paid" && !fee.paymentSmsSent && admission.alarmMobile && admission.alarmMobile.length > 0) {
            const paymentDateStr = fee.paymentDate
                ? new Date(fee.paymentDate).toLocaleDateString("bn-BD")
                : new Date().toLocaleDateString("bn-BD");
            const message = `${admission.studentName} (${admission.studentId || "N/A"}) - মাসিক ফি পরিশোধ করা হয়েছে\nপরিমাণ: ৳${fee.amountPaid}\nতারিখ: ${paymentDateStr}`;
            const smsResult = await sendSMS(admission.alarmMobile, message);
            if (smsResult.success) {
                fee.paymentSmsSent = true;
                fee.paymentSmsSentAt = new Date();
                await fee.save();
                paymentSmsSent = true;
            }
        }
        res.status(200).json({
            success: true,
            message: "Fee updated successfully",
            data: fee,
            paymentSmsSent,
        });
    }
    catch (error) {
        console.error("Update fee error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating fee",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updateFee = updateFee;
// Delete fee
const deleteFee = async (req, res) => {
    try {
        const { id } = req.params;
        const fee = await fee_1.default.findByIdAndDelete(id);
        if (!fee) {
            res.status(404).json({
                success: false,
                message: "Fee not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "Fee deleted successfully",
        });
    }
    catch (error) {
        console.error("Delete fee error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting fee",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteFee = deleteFee;
// Send payment reminder SMS
const sendPaymentReminderSMS = async (req, res) => {
    try {
        const { feeId, admissionId, studentId } = req.body;
        let fee;
        if (feeId) {
            fee = await fee_1.default.findById(feeId).populate("admissionId");
        }
        else if (admissionId) {
            // Get latest pending fee for this admission
            fee = await fee_1.default.findOne({ admissionId, status: { $in: ["pending", "overdue"] } })
                .sort({ dueDate: -1 })
                .populate("admissionId");
        }
        else if (studentId) {
            const admission = await admission_1.default.findOne({ studentId });
            if (admission) {
                fee = await fee_1.default.findOne({ admissionId: admission._id, status: { $in: ["pending", "overdue"] } })
                    .sort({ dueDate: -1 })
                    .populate("admissionId");
            }
        }
        if (!fee) {
            res.status(404).json({
                success: false,
                message: "Fee record not found",
            });
            return;
        }
        const admission = fee.admissionId;
        if (!admission.alarmMobile || admission.alarmMobile.length === 0) {
            res.status(400).json({
                success: false,
                message: "No mobile numbers configured for SMS notifications",
            });
            return;
        }
        const dueDateStr = new Date(fee.dueDate).toLocaleDateString("bn-BD");
        const message = `${admission.studentName} (${admission.studentId || "N/A"}) - মাসিক ফি পরিশোধের জন্য অনুস্মারক\nপরিমাণ: ৳${fee.monthlyFee}\nপরিশোধের তারিখ: ${dueDateStr}\nবকেয়া: ৳${fee.amountDue}`;
        const smsResult = await sendSMS(admission.alarmMobile, message);
        if (smsResult.success) {
            fee.reminderSmsSent = true;
            fee.reminderSmsSentAt = new Date();
            await fee.save();
            res.status(200).json({
                success: true,
                message: "Payment reminder SMS sent successfully",
                data: {
                    sentTo: smsResult.sentTo,
                    fee,
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
        console.error("Send payment reminder SMS error:", error);
        res.status(500).json({
            success: false,
            message: "Error sending payment reminder SMS",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.sendPaymentReminderSMS = sendPaymentReminderSMS;
// Send overdue SMS
const sendOverdueSMS = async (req, res) => {
    try {
        const { feeId, admissionId, studentId } = req.body;
        let fee;
        if (feeId) {
            fee = await fee_1.default.findById(feeId).populate("admissionId");
        }
        else if (admissionId) {
            fee = await fee_1.default.findOne({ admissionId, status: "overdue" })
                .sort({ dueDate: -1 })
                .populate("admissionId");
        }
        else if (studentId) {
            const admission = await admission_1.default.findOne({ studentId });
            if (admission) {
                fee = await fee_1.default.findOne({ admissionId: admission._id, status: "overdue" })
                    .sort({ dueDate: -1 })
                    .populate("admissionId");
            }
        }
        if (!fee) {
            res.status(404).json({
                success: false,
                message: "Overdue fee record not found",
            });
            return;
        }
        if (fee.status !== "overdue") {
            res.status(400).json({
                success: false,
                message: "Fee is not overdue",
            });
            return;
        }
        const admission = fee.admissionId;
        if (!admission.alarmMobile || admission.alarmMobile.length === 0) {
            res.status(400).json({
                success: false,
                message: "No mobile numbers configured for SMS notifications",
            });
            return;
        }
        const dueDateStr = new Date(fee.dueDate).toLocaleDateString("bn-BD");
        const message = `${admission.studentName} (${admission.studentId || "N/A"}) - মাসিক ফি বকেয়া\nপরিমাণ: ৳${fee.monthlyFee}\nবকেয়া: ৳${fee.amountDue}\nপরিশোধের তারিখ: ${dueDateStr}\nঅনুগ্রহ করে দ্রুত পরিশোধ করুন।`;
        const smsResult = await sendSMS(admission.alarmMobile, message);
        if (smsResult.success) {
            fee.overdueSmsSent = true;
            fee.overdueSmsSentAt = new Date();
            await fee.save();
            res.status(200).json({
                success: true,
                message: "Overdue SMS sent successfully",
                data: {
                    sentTo: smsResult.sentTo,
                    fee,
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
        console.error("Send overdue SMS error:", error);
        res.status(500).json({
            success: false,
            message: "Error sending overdue SMS",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.sendOverdueSMS = sendOverdueSMS;
// Send payment confirmation SMS
const sendPaymentConfirmationSMS = async (req, res) => {
    try {
        const { feeId } = req.body;
        if (!feeId) {
            res.status(400).json({
                success: false,
                message: "Fee ID is required",
            });
            return;
        }
        const fee = await fee_1.default.findById(feeId).populate("admissionId");
        if (!fee) {
            res.status(404).json({
                success: false,
                message: "Fee not found",
            });
            return;
        }
        if (fee.status !== "paid") {
            res.status(400).json({
                success: false,
                message: "Fee is not paid",
            });
            return;
        }
        const admission = fee.admissionId;
        if (!admission.alarmMobile || admission.alarmMobile.length === 0) {
            res.status(400).json({
                success: false,
                message: "No mobile numbers configured for SMS notifications",
            });
            return;
        }
        if (fee.paymentSmsSent) {
            res.status(400).json({
                success: false,
                message: "Payment confirmation SMS already sent",
            });
            return;
        }
        const paymentDateStr = fee.paymentDate
            ? new Date(fee.paymentDate).toLocaleDateString("bn-BD")
            : new Date().toLocaleDateString("bn-BD");
        const message = `${admission.studentName} (${admission.studentId || "N/A"}) - মাসিক ফি পরিশোধ করা হয়েছে\nপরিমাণ: ৳${fee.amountPaid}\nতারিখ: ${paymentDateStr}\nধন্যবাদ!`;
        const smsResult = await sendSMS(admission.alarmMobile, message);
        if (smsResult.success) {
            fee.paymentSmsSent = true;
            fee.paymentSmsSentAt = new Date();
            await fee.save();
            res.status(200).json({
                success: true,
                message: "Payment confirmation SMS sent successfully",
                data: {
                    sentTo: smsResult.sentTo,
                    fee,
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
        console.error("Send payment confirmation SMS error:", error);
        res.status(500).json({
            success: false,
            message: "Error sending payment confirmation SMS",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.sendPaymentConfirmationSMS = sendPaymentConfirmationSMS;
// Get fee statistics
const getFeeStats = async (req, res) => {
    try {
        const { month, year, class: classFilter } = req.query;
        const query = {};
        if (month)
            query.month = Number(month);
        if (year)
            query.year = Number(year);
        if (classFilter) {
            const admissions = await admission_1.default.find({ class: classFilter }).select("_id");
            const admissionIds = admissions.map((a) => a._id);
            query.admissionId = { $in: admissionIds };
        }
        const [total, paid, pending, overdue, partial] = await Promise.all([
            fee_1.default.countDocuments(query),
            fee_1.default.countDocuments({ ...query, status: "paid" }),
            fee_1.default.countDocuments({ ...query, status: "pending" }),
            fee_1.default.countDocuments({ ...query, status: "overdue" }),
            fee_1.default.countDocuments({ ...query, status: "partial" }),
        ]);
        // Calculate total amounts
        const fees = await fee_1.default.find(query);
        const totalAmount = fees.reduce((sum, fee) => sum + fee.monthlyFee, 0);
        const totalPaid = fees.reduce((sum, fee) => sum + fee.amountPaid, 0);
        const totalDue = fees.reduce((sum, fee) => sum + fee.amountDue, 0);
        res.status(200).json({
            success: true,
            data: {
                total,
                paid,
                pending,
                overdue,
                partial,
                totalAmount,
                totalPaid,
                totalDue,
                collectionRate: totalAmount > 0 ? ((totalPaid / totalAmount) * 100).toFixed(2) : "0.00",
            },
        });
    }
    catch (error) {
        console.error("Get fee stats error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching fee statistics",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getFeeStats = getFeeStats;
// Bulk create fees for a month
const createBulkFees = async (req, res) => {
    try {
        const { month, year, dueDate, class: classFilter, batchName } = req.body;
        if (!month || !year || !dueDate) {
            res.status(400).json({
                success: false,
                message: "Month, year, and due date are required",
            });
            return;
        }
        // Get all active admissions
        const admissionQuery = { status: "active" };
        if (classFilter)
            admissionQuery.class = classFilter;
        if (batchName)
            admissionQuery.batchName = batchName;
        const admissions = await admission_1.default.find(admissionQuery);
        if (admissions.length === 0) {
            res.status(404).json({
                success: false,
                message: "No active admissions found",
            });
            return;
        }
        const results = [];
        const errors = [];
        for (const admission of admissions) {
            try {
                // Check if fee already exists
                const existingFee = await fee_1.default.findOne({
                    admissionId: admission._id,
                    month: Number(month),
                    year: Number(year),
                });
                if (existingFee) {
                    errors.push({
                        admissionId: admission._id,
                        studentName: admission.studentName,
                        error: "Fee already exists for this month/year",
                    });
                    continue;
                }
                const fee = await fee_1.default.create({
                    admissionId: admission._id,
                    studentId: admission.studentId,
                    studentName: admission.studentName,
                    monthlyFee: admission.monthlyFee,
                    amountPaid: 0,
                    dueDate: new Date(dueDate),
                    month: Number(month),
                    year: Number(year),
                    status: "pending",
                    createdBy: req.user?.userId,
                });
                results.push({
                    admissionId: admission._id,
                    studentName: admission.studentName,
                    fee,
                });
            }
            catch (error) {
                errors.push({
                    admissionId: admission._id,
                    studentName: admission.studentName,
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            }
        }
        res.status(200).json({
            success: true,
            message: `Fees created for ${results.length} student(s)`,
            data: results,
            errors: errors.length > 0 ? errors : undefined,
        });
    }
    catch (error) {
        console.error("Create bulk fees error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating bulk fees",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createBulkFees = createBulkFees;
//# sourceMappingURL=feeController.js.map