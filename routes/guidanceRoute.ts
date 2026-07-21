import { Router } from "express";
import { generateGuidance, latestGuidance } from "../controller/guidanceController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const limit = securityRateLimit({ name: "proposal-guidance", limit: 60, windowMs: 15 * 60_000 });

router.post("/proposals/:proposalId/guidance-reports", authenticate, authorizeAction("proposal:write"), limit, generateGuidance);
router.get("/proposals/:proposalId/guidance-reports/latest", authenticate, authorizeAction("proposal:read"), latestGuidance);

export default router;
