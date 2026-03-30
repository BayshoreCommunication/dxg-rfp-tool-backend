import { Router } from "express";
import {
  deleteEmailCampaignById,
  deleteEmailCampaignsByProposal,
  getEmailCampaigns,
  getEmailStats,
  markEmailClicked,
  markEmailOpened,
  sendProposalEmailCampaign,
} from "../controller/emailController";
import { authenticate } from "../middleware/auth";

const router = Router();

// Public tracking endpoints
router.get("/open/:trackingId", markEmailOpened);
router.get("/click/:trackingId", markEmailClicked);

// Protected endpoints
router.post("/send", authenticate, sendProposalEmailCampaign);
router.get("/", authenticate, getEmailCampaigns);
router.get("/stats", authenticate, getEmailStats);
router.delete("/proposal/:proposalId", authenticate, deleteEmailCampaignsByProposal);
router.delete("/:campaignId", authenticate, deleteEmailCampaignById);

export default router;
