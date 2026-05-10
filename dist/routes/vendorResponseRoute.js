"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const mongoose_1 = __importDefault(require("mongoose"));
const vendorResponseController_1 = require("../controller/vendorResponseController");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
const validateResponseId = (req, res, next) => {
    if (!mongoose_1.default.isValidObjectId(req.params.id)) {
        res.status(400).json({ success: false, message: "Invalid response id" });
        return;
    }
    next();
};
/* Public routes — no authentication required */
router.get("/check", vendorResponseController_1.checkVendorResponseExists);
router.post("/", upload_1.uploadVendorDocs, vendorResponseController_1.submitVendorResponse);
/* Protected routes — planner dashboard */
router.get("/", auth_1.authenticate, vendorResponseController_1.getVendorResponses);
router.get("/:id", auth_1.authenticate, validateResponseId, vendorResponseController_1.getVendorResponseById);
router.patch("/:id/read", auth_1.authenticate, validateResponseId, vendorResponseController_1.markVendorResponseRead);
exports.default = router;
