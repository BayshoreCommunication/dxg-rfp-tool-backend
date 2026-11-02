import { Router } from "express";
import {
  getOrganizationSecurity,
  resetMemberTwoFactor,
  updateOrganizationSecurity,
} from "../controller/organizationSecurityController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/organization. Owner and Admin only (organization:manage).
const router = Router();
const manage = [authenticate, authorizeAction("organization:manage")];
const writes = securityRateLimit({ name: "organization-security-write", limit: 30, windowMs: 15 * 60_000 });

router.get("/security", ...manage, getOrganizationSecurity);
router.put("/security", ...manage, writes, updateOrganizationSecurity);
router.post("/members/:userId/two-factor/reset", ...manage, writes, resetMemberTwoFactor);

export default router;
