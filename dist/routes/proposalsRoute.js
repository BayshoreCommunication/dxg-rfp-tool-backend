"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const mongoose_1 = __importDefault(require("mongoose"));
const proposalsController_1 = require("../controller/proposalsController");
const jwt_1 = require("../config/jwt");
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
// Attaches req.user when a valid Bearer token is present, always calls next()
const optionalAuth = (req, _res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        try {
            req.user = (0, jwt_1.verifyAccessToken)(authHeader.substring(7));
        }
        catch {
            // Invalid / expired token — continue as unauthenticated
        }
    }
    next();
};
/* Protected static routes — must come BEFORE /:id wildcard */
router.get("/", auth_1.authenticate, proposalsController_1.getAllProposals);
router.post("/", auth_1.authenticate, proposalsController_1.createProposal);
router.post("/upload-files", auth_1.authenticate, upload_1.uploadProposalDocs, proposalsController_1.uploadProposalFiles);
/* Routes accessible with or without auth — different controller per case */
router.get("/:id", validateProposalId, optionalAuth, (req, res) => {
    if (req.user)
        return (0, proposalsController_1.getProposalById)(req, res);
    return (0, proposalsController_1.getProposalByIdPublic)(req, res);
});
router.patch("/:id/views", validateProposalId, optionalAuth, (req, res) => {
    if (req.user)
        return (0, proposalsController_1.incrementProposalViews)(req, res);
    return (0, proposalsController_1.incrementProposalViewsPublic)(req, res);
});
/* Protected routes (require auth) */
router.post("/:id/copy", auth_1.authenticate, validateProposalId, proposalsController_1.copyProposal);
router.put("/:id", auth_1.authenticate, validateProposalId, proposalsController_1.updateProposal);
router.patch("/:id/status", auth_1.authenticate, validateProposalId, proposalsController_1.updateProposalStatus);
router.patch("/:id/meta", auth_1.authenticate, validateProposalId, proposalsController_1.updateProposalMeta);
router.patch("/:id/restore", auth_1.authenticate, validateProposalId, proposalsController_1.restoreProposal);
router.delete("/:id/permanent", auth_1.authenticate, validateProposalId, proposalsController_1.permanentlyDeleteProposal);
router.delete("/:id", auth_1.authenticate, validateProposalId, proposalsController_1.deleteProposal);
exports.default = router;
//# sourceMappingURL=proposalsRoute.js.map