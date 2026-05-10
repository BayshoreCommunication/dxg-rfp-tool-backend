import { NextFunction, Request, Response, Router } from "express";
import mongoose from "mongoose";
import {
  copyProposal,
  createProposal,
  deleteProposal,
  getAllProposals,
  getProposalById,
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
import { verifyAccessToken } from "../config/jwt";
import { authenticate, type AuthRequest } from "../middleware/auth";
import { uploadProposalDocs } from "../middleware/upload";

const router = Router();

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
    try {
      (req as AuthRequest).user = verifyAccessToken(authHeader.substring(7));
    } catch {
      // Invalid / expired token — continue as unauthenticated
    }
  }
  next();
};

/* Protected static routes — must come BEFORE /:id wildcard */
router.get("/", authenticate, getAllProposals);
router.post("/", authenticate, createProposal);
router.post("/upload-files", authenticate, uploadProposalDocs, uploadProposalFiles);

/* Routes accessible with or without auth — different controller per case */
router.get("/:id", validateProposalId, optionalAuth, (req: Request, res: Response) => {
  if ((req as AuthRequest).user) return getProposalById(req as AuthRequest, res);
  return getProposalByIdPublic(req, res);
});

router.patch("/:id/views", validateProposalId, optionalAuth, (req: Request, res: Response) => {
  if ((req as AuthRequest).user) return incrementProposalViews(req as AuthRequest, res);
  return incrementProposalViewsPublic(req, res);
});

/* Protected routes (require auth) */
router.post("/:id/copy", authenticate, validateProposalId, copyProposal);
router.put("/:id", authenticate, validateProposalId, updateProposal);
router.patch("/:id/status", authenticate, validateProposalId, updateProposalStatus);
router.patch("/:id/meta", authenticate, validateProposalId, updateProposalMeta);
router.patch("/:id/restore", authenticate, validateProposalId, restoreProposal);
router.delete("/:id/permanent", authenticate, validateProposalId, permanentlyDeleteProposal);
router.delete("/:id", authenticate, validateProposalId, deleteProposal);

export default router;
