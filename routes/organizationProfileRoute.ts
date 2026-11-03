import { Router } from "express";
import { getOrganizationProfile, updateOrganizationProfile } from "../controller/organizationProfileController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/organization. Any member reads; Owner and Admin rename (organization:manage).
const router = Router();
const writes = securityRateLimit({ name: "organization-profile-write", limit: 30, windowMs: 15 * 60_000 });

router.get("/profile", authenticate, getOrganizationProfile);
router.put("/profile", authenticate, authorizeAction("organization:manage"), writes, updateOrganizationProfile);

export default router;
