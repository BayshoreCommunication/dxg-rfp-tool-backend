import { NextFunction, Request, Response, Router } from "express";
import mongoose from "mongoose";
import {
  createProposal,
  deleteProposal,
  getAllProposals,
  getProposalById,
  incrementProposalViews,
  updateProposal,
  updateProposalMeta,
  updateProposalStatus,
  uploadProposalFiles,
} from "../controller/proposalsController";
import { authenticate } from "../middleware/auth";
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

/* Protected routes (require auth) */
router.post("/upload-files", authenticate, uploadProposalDocs, uploadProposalFiles);
router.post("/", authenticate, createProposal);
router.get("/", authenticate, getAllProposals);
router.get("/:id", authenticate, validateProposalId, getProposalById);
router.put("/:id", authenticate, validateProposalId, updateProposal);
router.patch("/:id/status", authenticate, validateProposalId, updateProposalStatus);
router.patch("/:id/meta", authenticate, validateProposalId, updateProposalMeta);
router.patch("/:id/views", authenticate, validateProposalId, incrementProposalViews);
router.delete("/:id", authenticate, validateProposalId, deleteProposal);

export default router;
