import { Router } from "express";
import {
  chooseOnboardingPlan,
  completeOnboarding,
  getOrganizationProfile,
  updateOrganizationProfile,
} from "../controller/organizationProfileController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/organization. Any member reads; Owner and Admin (organization:manage) change the
// profile and walk onboarding.
const router = Router();
const writes = securityRateLimit({ name: "organization-profile-write", limit: 30, windowMs: 15 * 60_000 });
const manage = authorizeAction("organization:manage");

router.get("/profile", authenticate, getOrganizationProfile);
router.put("/profile", authenticate, manage, writes, updateOrganizationProfile);
router.post("/onboarding/plan", authenticate, manage, writes, chooseOnboardingPlan);
router.post("/onboarding/complete", authenticate, manage, writes, completeOnboarding);

export default router;
