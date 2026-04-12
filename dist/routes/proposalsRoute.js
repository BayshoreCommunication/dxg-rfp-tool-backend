"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const mongoose_1 = __importDefault(require("mongoose"));
const proposalsController_1 = require("../controller/proposalsController");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
const validateProposalId = (req, res, next) => {
    const { id } = req.params;
    if (!mongoose_1.default.isValidObjectId(id)) {
        res.status(400).json({
            success: false,
            message: "Invalid proposal id",
        });
        return;
    }
    next();
};
/* Protected routes (require auth) */
router.post("/upload-files", auth_1.authenticate, upload_1.uploadProposalDocs, proposalsController_1.uploadProposalFiles);
router.post("/", auth_1.authenticate, proposalsController_1.createProposal);
router.get("/", auth_1.authenticate, proposalsController_1.getAllProposals);
router.get("/:id", auth_1.authenticate, validateProposalId, proposalsController_1.getProposalById);
router.put("/:id", auth_1.authenticate, validateProposalId, proposalsController_1.updateProposal);
router.patch("/:id/status", auth_1.authenticate, validateProposalId, proposalsController_1.updateProposalStatus);
router.patch("/:id/meta", auth_1.authenticate, validateProposalId, proposalsController_1.updateProposalMeta);
router.patch("/:id/views", auth_1.authenticate, validateProposalId, proposalsController_1.incrementProposalViews);
router.delete("/:id", auth_1.authenticate, validateProposalId, proposalsController_1.deleteProposal);
exports.default = router;
//# sourceMappingURL=proposalsRoute.js.map