"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyQRCode = exports.bulkGenerateQRCodes = exports.deleteQRCode = exports.updateQRCode = exports.getQRCodeById = exports.getQRCodes = exports.createQRCode = void 0;
const qrcode_1 = __importDefault(require("../modal/qrcode"));
// Create QR code
const createQRCode = async (req, res) => {
    try {
        const { name, type, content, description, studentId, admissionId, examId, expiresAt, isActive = true, metadata, } = req.body;
        // Validation
        if (!name || !type || !content) {
            res.status(400).json({
                success: false,
                message: "Please provide name, type, and content",
            });
            return;
        }
        // Validate type
        const validTypes = [
            "student",
            "exam",
            "admission",
            "custom",
            "url",
            "text",
        ];
        if (!validTypes.includes(type)) {
            res.status(400).json({
                success: false,
                message: `Invalid type. Allowed types: ${validTypes.join(", ")}`,
            });
            return;
        }
        const qrCode = await qrcode_1.default.create({
            name,
            type,
            content,
            description,
            studentId,
            admissionId,
            examId,
            expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            isActive: isActive !== undefined ? isActive : true,
            metadata: metadata || {},
            createdBy: req.user?.userId,
        });
        res.status(201).json({
            success: true,
            message: "QR code created successfully",
            data: qrCode,
        });
    }
    catch (error) {
        console.error("Create QR code error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating QR code",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createQRCode = createQRCode;
// Get QR codes
const getQRCodes = async (req, res) => {
    try {
        const { page = "1", limit = "50", type, studentId, admissionId, examId, isActive, search, } = req.query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const skip = (pageNum - 1) * limitNum;
        const query = {};
        // Apply filters
        if (type)
            query.type = type;
        if (studentId)
            query.studentId = studentId;
        if (admissionId)
            query.admissionId = admissionId;
        if (examId)
            query.examId = examId;
        if (isActive !== undefined) {
            const isActiveValue = String(isActive).toLowerCase();
            query.isActive = isActiveValue === "true" || isActiveValue === "1";
        }
        // Text search - MongoDB will combine $or with other query fields using implicit AND
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { content: { $regex: search, $options: "i" } },
                { description: { $regex: search, $options: "i" } },
            ];
        }
        const [qrCodes, total] = await Promise.all([
            qrcode_1.default.find(query)
                .populate("createdBy", "name email")
                .populate("updatedBy", "name email")
                .populate("admissionId", "studentName studentId")
                .populate("examId", "examName")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum),
            qrcode_1.default.countDocuments(query),
        ]);
        res.status(200).json({
            success: true,
            data: qrCodes || [],
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: total || 0,
                totalPages: Math.ceil((total || 0) / limitNum),
                hasNext: skip + limitNum < (total || 0),
                hasPrev: pageNum > 1,
            },
        });
    }
    catch (error) {
        console.error("Get QR codes error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching QR codes",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getQRCodes = getQRCodes;
// Get single QR code by ID
const getQRCodeById = async (req, res) => {
    try {
        const { id } = req.params;
        const qrCode = await qrcode_1.default.findById(id)
            .populate("createdBy", "name email")
            .populate("updatedBy", "name email")
            .populate("admissionId", "studentName studentId")
            .populate("examId", "examName");
        if (!qrCode) {
            res.status(404).json({
                success: false,
                message: "QR code not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            data: qrCode,
        });
    }
    catch (error) {
        console.error("Get QR code by ID error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching QR code",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getQRCodeById = getQRCodeById;
// Update QR code
const updateQRCode = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, type, content, description, studentId, admissionId, examId, expiresAt, isActive, metadata, } = req.body;
        // Check if QR code exists
        const existingQRCode = await qrcode_1.default.findById(id);
        if (!existingQRCode) {
            res.status(404).json({
                success: false,
                message: "QR code not found",
            });
            return;
        }
        // Validate type if provided
        if (type) {
            const validTypes = [
                "student",
                "exam",
                "admission",
                "custom",
                "url",
                "text",
            ];
            if (!validTypes.includes(type)) {
                res.status(400).json({
                    success: false,
                    message: `Invalid type. Allowed types: ${validTypes.join(", ")}`,
                });
                return;
            }
        }
        // Build update object
        const updateData = {};
        if (name !== undefined)
            updateData.name = name;
        if (type !== undefined)
            updateData.type = type;
        if (content !== undefined)
            updateData.content = content;
        if (description !== undefined)
            updateData.description = description;
        if (studentId !== undefined)
            updateData.studentId = studentId;
        if (admissionId !== undefined)
            updateData.admissionId = admissionId;
        if (examId !== undefined)
            updateData.examId = examId;
        if (expiresAt !== undefined) {
            updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
        }
        if (isActive !== undefined)
            updateData.isActive = isActive;
        if (metadata !== undefined)
            updateData.metadata = metadata;
        updateData.updatedBy = req.user?.userId;
        const qrCode = await qrcode_1.default.findByIdAndUpdate(id, updateData, {
            new: true,
            runValidators: true,
        })
            .populate("createdBy", "name email")
            .populate("updatedBy", "name email")
            .populate("admissionId", "studentName studentId")
            .populate("examId", "examName");
        res.status(200).json({
            success: true,
            message: "QR code updated successfully",
            data: qrCode,
        });
    }
    catch (error) {
        console.error("Update QR code error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating QR code",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updateQRCode = updateQRCode;
// Delete QR code
const deleteQRCode = async (req, res) => {
    try {
        const { id } = req.params;
        const qrCode = await qrcode_1.default.findByIdAndDelete(id);
        if (!qrCode) {
            res.status(404).json({
                success: false,
                message: "QR code not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "QR code deleted successfully",
        });
    }
    catch (error) {
        console.error("Delete QR code error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting QR code",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteQRCode = deleteQRCode;
// Bulk generate QR codes
const bulkGenerateQRCodes = async (req, res) => {
    try {
        const { qrCodes } = req.body;
        if (!Array.isArray(qrCodes) || qrCodes.length === 0) {
            res.status(400).json({
                success: false,
                message: "Please provide an array of QR codes",
            });
            return;
        }
        // Validate each QR code
        const validTypes = [
            "student",
            "exam",
            "admission",
            "custom",
            "url",
            "text",
        ];
        for (const qrData of qrCodes) {
            if (!qrData.name || !qrData.type || !qrData.content) {
                res.status(400).json({
                    success: false,
                    message: "Each QR code must have name, type, and content",
                });
                return;
            }
            if (!validTypes.includes(qrData.type)) {
                res.status(400).json({
                    success: false,
                    message: `Invalid type: ${qrData.type}. Allowed types: ${validTypes.join(", ")}`,
                });
                return;
            }
        }
        // Create QR codes
        const qrCodesToCreate = qrCodes.map((qrData) => ({
            ...qrData,
            expiresAt: qrData.expiresAt ? new Date(qrData.expiresAt) : undefined,
            isActive: qrData.isActive !== undefined ? qrData.isActive : true,
            metadata: qrData.metadata || {},
            createdBy: req.user?.userId,
        }));
        const createdQRCodes = await qrcode_1.default.insertMany(qrCodesToCreate);
        res.status(201).json({
            success: true,
            message: `${createdQRCodes.length} QR code(s) created successfully`,
            data: createdQRCodes,
        });
    }
    catch (error) {
        console.error("Bulk generate QR codes error:", error);
        res.status(500).json({
            success: false,
            message: "Error bulk generating QR codes",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.bulkGenerateQRCodes = bulkGenerateQRCodes;
// Verify QR code (check if content is valid/exists)
const verifyQRCode = async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) {
            res.status(400).json({
                success: false,
                message: "Please provide QR code content to verify",
            });
            return;
        }
        // Find QR code by content
        const qrCode = await qrcode_1.default.findOne({
            content,
            isActive: true,
            $or: [
                { expiresAt: { $exists: false } },
                { expiresAt: null },
                { expiresAt: { $gte: new Date() } },
            ],
        })
            .populate("admissionId", "studentName studentId")
            .populate("examId", "examName");
        if (!qrCode) {
            res.status(404).json({
                success: false,
                message: "QR code not found or expired",
                data: null,
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "QR code is valid",
            data: qrCode,
        });
    }
    catch (error) {
        console.error("Verify QR code error:", error);
        res.status(500).json({
            success: false,
            message: "Error verifying QR code",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.verifyQRCode = verifyQRCode;
//# sourceMappingURL=qrcodeController.js.map