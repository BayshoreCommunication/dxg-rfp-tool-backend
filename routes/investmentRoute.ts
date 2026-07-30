import { Router } from "express";
import { exportInvestmentGuidance, generateInvestmentGuidance, latestInvestmentGuidance } from "../controller/investmentController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const limit = securityRateLimit({ name: "investment-guidance", limit: 30, windowMs: 15 * 60_000 });

router.post("/proposals/:proposalId/investment-guidance-reports", authenticate, authorizeAction("proposal:write"), limit, generateInvestmentGuidance);
router.get("/proposals/:proposalId/investment-guidance-reports/latest", authenticate, authorizeAction("proposal:read"), latestInvestmentGuidance);
router.get("/proposals/:proposalId/investment-guidance-reports/export", authenticate, authorizeAction("proposal:read"), limit, exportInvestmentGuidance);

export default router;
