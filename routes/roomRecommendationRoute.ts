import { Router } from "express";
import {
  applyRoomRecommendations,
  generateRoomRecommendations,
  latestRoomRecommendations,
  readRoomRecommendationReview,
  saveRoomRecommendationReview,
} from "../controller/roomRecommendationController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const limit = securityRateLimit({ name: "room-recommendations", limit: 60, windowMs: 15 * 60_000 });

router.post("/proposals/:proposalId/room-recommendations", authenticate, authorizeAction("proposal:write"), limit, generateRoomRecommendations);
router.get("/proposals/:proposalId/room-recommendations/latest", authenticate, authorizeAction("proposal:read"), latestRoomRecommendations);
router.get("/proposals/:proposalId/room-recommendations/:runId/review", authenticate, authorizeAction("proposal:read"), readRoomRecommendationReview);
router.put("/proposals/:proposalId/room-recommendations/:runId/review", authenticate, authorizeAction("proposal:write"), limit, saveRoomRecommendationReview);
router.post("/proposals/:proposalId/room-recommendations/:runId/applications", authenticate, authorizeAction("proposal:write"), limit, applyRoomRecommendations);

export default router;
