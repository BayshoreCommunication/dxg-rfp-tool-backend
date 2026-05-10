"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markVendorResponseRead = exports.getVendorResponseById = exports.getVendorResponses = exports.submitVendorResponse = exports.checkVendorResponseExists = void 0;
const fs_1 = __importDefault(require("fs"));
const mongoose_1 = __importDefault(require("mongoose"));
const proposalsModel_1 = __importDefault(require("../modal/proposalsModel"));
const vendorResponseModel_1 = __importDefault(require("../modal/vendorResponseModel"));
const uploadToSpaces_1 = require("../utils/uploadToSpaces");
const notificationService_1 = require("../utils/notificationService");
const VENDOR_RESPONSE_SELECT = "_id proposalId proposalOwnerId proposalTitle vendorName submittedBy email message documents isRead createdAt updatedAt";
const checkVendorResponseExists = async (req, res) => {
    try {
        const { proposalId, email, tid } = req.query;
        if (!proposalId || !mongoose_1.default.isValidObjectId(proposalId)) {
            res.status(200).json({ alreadySubmitted: false });
            return;
        }
        const orConditions = [];
        if (email?.trim()) {
            orConditions.push({
                proposalId: new mongoose_1.default.Types.ObjectId(proposalId),
                email: email.trim().toLowerCase(),
            });
        }
        if (tid?.trim()) {
            orConditions.push({ emailTrackingId: tid.trim() });
        }
        if (orConditions.length === 0) {
            res.status(200).json({ alreadySubmitted: false });
            return;
        }
        const existing = await vendorResponseModel_1.default.findOne({ $or: orConditions })
            .select("_id")
            .lean();
        res.status(200).json({ alreadySubmitted: !!existing });
    }
    catch {
        res.status(200).json({ alreadySubmitted: false });
    }
};
exports.checkVendorResponseExists = checkVendorResponseExists;
const submitVendorResponse = async (req, res) => {
    try {
        const { proposalId, vendorName, submittedBy, email, message, emailTrackingId } = req.body;
        if (!proposalId || !mongoose_1.default.isValidObjectId(proposalId)) {
            res.status(400).json({ success: false, message: "Valid proposal id is required." });
            return;
        }
        if (!vendorName?.trim()) {
            res.status(400).json({ success: false, message: "Vendor name is required." });
            return;
        }
        if (!submittedBy?.trim()) {
            res.status(400).json({ success: false, message: "Submitted by is required." });
            return;
        }
        if (!email?.trim()) {
            res.status(400).json({ success: false, message: "Email is required." });
            return;
        }
        const normalizedEmail = email.trim().toLowerCase();
        const normalizedTid = emailTrackingId?.trim() || null;
        const orConditions = [
            { proposalId: new mongoose_1.default.Types.ObjectId(proposalId), email: normalizedEmail },
        ];
        if (normalizedTid) {
            orConditions.push({ emailTrackingId: normalizedTid });
        }
        const existing = await vendorResponseModel_1.default.findOne({ $or: orConditions }).lean();
        if (existing) {
            res.status(409).json({
                success: false,
                alreadySubmitted: true,
                message: "You have already submitted a response for this proposal.",
            });
            return;
        }
        const proposal = await proposalsModel_1.default.findById(proposalId).select("_id userId event");
        if (!proposal) {
            res.status(404).json({ success: false, message: "Proposal not found." });
            return;
        }
        const proposalTitle = proposal.event?.eventName?.trim() || "Untitled Proposal";
        const proposalOwnerId = proposal.userId;
        // Upload documents to Spaces
        const uploadedDocs = [];
        const files = req.files?.documents;
        if (Array.isArray(files)) {
            for (const file of files) {
                try {
                    const folder = process.env.DO_FOLDER_NAME || "rfp-tool";
                    const objectKey = `${folder}/vendor-responses/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
                    const url = await (0, uploadToSpaces_1.uploadToSpaces)(file.path, objectKey);
                    uploadedDocs.push({ name: file.originalname, url });
                }
                catch {
                    try { fs_1.default.unlinkSync(file.path); } catch { /* ignore */ }
                }
            }
        }
        const vendorResponse = await vendorResponseModel_1.default.create({
            proposalId: proposal._id,
            proposalOwnerId,
            proposalTitle,
            vendorName: vendorName.trim(),
            submittedBy: submittedBy.trim(),
            email: email.trim().toLowerCase(),
            message: message?.trim() || "",
            documents: uploadedDocs,
            ...(normalizedTid ? { emailTrackingId: normalizedTid } : {}),
        });
        await (0, notificationService_1.createNotification)({
            userId: String(proposalOwnerId),
            proposalId: String(proposal._id),
            type: "vendor_response",
            title: "New Vendor Response",
            message: `${vendorName.trim()} submitted a response for "${proposalTitle}".`,
            metadata: {
                vendorResponseId: String(vendorResponse._id),
                vendorName: vendorName.trim(),
                submittedBy: submittedBy.trim(),
                email: email.trim().toLowerCase(),
            },
        });
        res.status(201).json({
            success: true,
            message: "Your response has been submitted successfully.",
            data: vendorResponse,
        });
    }
    catch (error) {
        console.error("Submit vendor response error:", error);
        res.status(500).json({
            success: false,
            message: "Error submitting vendor response",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.submitVendorResponse = submitVendorResponse;
const getVendorResponses = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Authentication required" });
            return;
        }
        const { page = "1", limit = "20", unreadOnly = "false", proposalId } = req.query;
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
        const skip = (pageNum - 1) * limitNum;
        const filter = { proposalOwnerId: new mongoose_1.default.Types.ObjectId(userId) };
        if (unreadOnly === "true")
            filter.isRead = false;
        if (proposalId && mongoose_1.default.isValidObjectId(proposalId)) {
            filter.proposalId = new mongoose_1.default.Types.ObjectId(proposalId);
        }
        const [responses, total, unreadCount] = await Promise.all([
            vendorResponseModel_1.default.find(filter)
                .select(VENDOR_RESPONSE_SELECT)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            vendorResponseModel_1.default.countDocuments(filter),
            vendorResponseModel_1.default.countDocuments({ proposalOwnerId: new mongoose_1.default.Types.ObjectId(userId), isRead: false }),
        ]);
        res.status(200).json({
            success: true,
            data: responses,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
            },
            unreadCount,
        });
    }
    catch (error) {
        console.error("Get vendor responses error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching vendor responses",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getVendorResponses = getVendorResponses;
const getVendorResponseById = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Authentication required" });
            return;
        }
        const { id } = req.params;
        if (!mongoose_1.default.isValidObjectId(id)) {
            res.status(400).json({ success: false, message: "Invalid response id" });
            return;
        }
        const response = await vendorResponseModel_1.default.findOneAndUpdate({ _id: id, proposalOwnerId: new mongoose_1.default.Types.ObjectId(userId) }, { isRead: true }, { new: true })
            .select(VENDOR_RESPONSE_SELECT)
            .lean();
        if (!response) {
            res.status(404).json({ success: false, message: "Vendor response not found" });
            return;
        }
        res.status(200).json({ success: true, data: response });
    }
    catch (error) {
        console.error("Get vendor response by id error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching vendor response",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getVendorResponseById = getVendorResponseById;
const markVendorResponseRead = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Authentication required" });
            return;
        }
        const { id } = req.params;
        if (!mongoose_1.default.isValidObjectId(id)) {
            res.status(400).json({ success: false, message: "Invalid response id" });
            return;
        }
        const response = await vendorResponseModel_1.default.findOneAndUpdate({ _id: id, proposalOwnerId: new mongoose_1.default.Types.ObjectId(userId) }, { isRead: true }, { new: true })
            .select(VENDOR_RESPONSE_SELECT)
            .lean();
        if (!response) {
            res.status(404).json({ success: false, message: "Vendor response not found" });
            return;
        }
        res.status(200).json({
            success: true,
            message: "Marked as read",
            data: response,
        });
    }
    catch (error) {
        console.error("Mark vendor response read error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating vendor response",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.markVendorResponseRead = markVendorResponseRead;
