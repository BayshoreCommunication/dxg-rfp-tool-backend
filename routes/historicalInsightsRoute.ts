import { Router } from "express";
import {
  generateHistoricalInsights,
  latestHistoricalInsights,
} from "../controller/historicalInsightsController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const limit = securityRateLimit({
  name: "historical-insights",
  limit: 30,
  windowMs: 15 * 60_000,
});

router.post(
  "/proposals/:proposalId/historical-insights",
  authenticate,
  authorizeAction("proposal:read"),
  limit,
  generateHistoricalInsights,
);
router.get(
  "/proposals/:proposalId/historical-insights/latest",
  authenticate,
  authorizeAction("proposal:read"),
  latestHistoricalInsights,
);

export default router;
