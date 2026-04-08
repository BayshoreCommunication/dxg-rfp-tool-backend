import { Router } from "express";
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

/* Protected routes (require auth) */
router.post("/upload-files", authenticate, uploadProposalDocs, uploadProposalFiles);
router.post("/", authenticate, createProposal);
router.get("/", authenticate, getAllProposals);
router.get("/:id", authenticate, getProposalById);
router.put("/:id", authenticate, updateProposal);
router.patch("/:id/status", authenticate, updateProposalStatus);
router.patch("/:id/meta", authenticate, updateProposalMeta);
router.patch("/:id/views", authenticate, incrementProposalViews);
router.delete("/:id", authenticate, deleteProposal);

export default router;
