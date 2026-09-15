import { Router } from "express";
import { getDashboardOverview } from "../controller/dashboardController";
import { getOnboardingFunnelReport } from "../controller/onboardingFunnelController";
import { authenticate, authorizeAction } from "../middleware/auth";

const router = Router();

router.get("/overview", authenticate, getDashboardOverview);
// Aggregate-only onboarding funnel for administrators: first message and
// first draft as time from account start and as a share of new accounts.
router.get(
  "/onboarding-funnel",
  authenticate,
  authorizeAction("security:admin"),
  getOnboardingFunnelReport,
);

export default router;
