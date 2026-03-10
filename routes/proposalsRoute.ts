import { Router } from "express";
import {
  createProposal,
  deleteProposal,
  getAllProposals,
  getProposalById,
  updateProposal,
  updateProposalStatus,
} from "../controller/proposalsController";
import { authenticate } from "../middleware/auth";

const router = Router();

/* ─── Public routes ─── */
// POST — submit a new proposal (public so clients without accounts can submit)
router.post("/", createProposal);

/* ─── Protected routes (require auth) ─── */
// GET all proposals with filtering, search, pagination
router.get("/", authenticate, getAllProposals);

// GET single proposal
router.get("/:id", authenticate, getProposalById);

// PUT — full/partial update
router.put("/:id", authenticate, updateProposal);

// PATCH — status-only update (e.g. approve/reject)
router.patch("/:id/status", authenticate, updateProposalStatus);

// DELETE
router.delete("/:id", authenticate, deleteProposal);

export default router;
