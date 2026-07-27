import { NextFunction, Request, Response, Router } from "express";
import mongoose from "mongoose";
import {
  copyProposal,
  createProposal,
  deleteProposal,
  getAllProposals,
  getProposalById,
  getProposalFileUrl,
  getProposalByIdPublic,
  incrementProposalViews,
  incrementProposalViewsPublic,
  permanentlyDeleteProposal,
  restoreProposal,
  updateProposal,
  updateProposalMeta,
  updateProposalStatus,
  uploadProposalFiles,
} from "../controller/proposalsController";
import { authenticate, authorizeAction, type AuthRequest } from "../middleware/auth";
import { uploadProposalDocs } from "../middleware/upload";
import { requirePublicGrant } from "../middleware/publicAccess";
import { grantAndIpIdentity, securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const publicProposalLimit = securityRateLimit({ name: "proposal-public", limit: 120, windowMs: 15 * 60_000, identity: grantAndIpIdentity });

const validateProposalId = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({
      success: false,
      message: "Invalid proposal id",
    });
    return;
  }

  next();
};

// Attaches req.user when a valid Bearer token is present, always calls next()
const optionalAuth = (req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    void authenticate(req as AuthRequest, _res, next);
    return;
  }
  next();
};

/* Protected static routes — must come BEFORE /:id wildcard */
router.get("/", authenticate, authorizeAction("proposal:read"), getAllProposals);
router.post("/", authenticate, authorizeAction("proposal:write"), createProposal);
// Support documents are private objects; this issues the short-lived link.
router.get("/file-url", authenticate, authorizeAction("proposal:read"), getProposalFileUrl);
router.post("/upload-files", authenticate, authorizeAction("proposal:write"), uploadProposalDocs, uploadProposalFiles);

/* Routes accessible with or without auth — different controller per case */
router.get("/:id", validateProposalId, optionalAuth, publicProposalLimit, requirePublicGrant(["proposal:view", "vendor:submit"]), (req: Request, res: Response) => {
  if ((req as AuthRequest).user) return getProposalById(req as AuthRequest, res);
  return getProposalByIdPublic(req, res);
});

router.patch("/:id/views", validateProposalId, optionalAuth, publicProposalLimit, requirePublicGrant("proposal:view"), (req: Request, res: Response) => {
  if ((req as AuthRequest).user) return incrementProposalViews(req as AuthRequest, res);
  return incrementProposalViewsPublic(req, res);
});

/* Protected routes (require auth) */
router.post("/:id/copy", authenticate, authorizeAction("proposal:write"), validateProposalId, copyProposal);
router.put("/:id", authenticate, authorizeAction("proposal:write"), validateProposalId, updateProposal);
router.patch("/:id/status", authenticate, authorizeAction("proposal:publish"), validateProposalId, updateProposalStatus);
router.patch("/:id/meta", authenticate, authorizeAction("proposal:write"), validateProposalId, updateProposalMeta);
router.patch("/:id/restore", authenticate, authorizeAction("proposal:write"), validateProposalId, restoreProposal);
router.delete("/:id/permanent", authenticate, authorizeAction("proposal:write"), validateProposalId, permanentlyDeleteProposal);
router.delete("/:id", authenticate, authorizeAction("proposal:write"), validateProposalId, deleteProposal);

export default router;
