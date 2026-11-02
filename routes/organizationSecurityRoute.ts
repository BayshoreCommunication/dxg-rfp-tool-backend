import { Router } from "express";
import {
  getOrganizationSecurity,
  resetMemberTwoFactor,
  updateOrganizationSecurity,
} from "../controller/organizationSecurityController";
import { addDomain, checkDomain, listDomains, removeDomain } from "../controller/organizationDomainsController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/organization. Owner and Admin only (organization:manage).
const router = Router();
const manage = [authenticate, authorizeAction("organization:manage")];
const writes = securityRateLimit({ name: "organization-security-write", limit: 30, windowMs: 15 * 60_000 });

router.get("/security", ...manage, getOrganizationSecurity);
router.put("/security", ...manage, writes, updateOrganizationSecurity);
router.post("/members/:userId/two-factor/reset", ...manage, writes, resetMemberTwoFactor);

// ORG-305 verified domains. The background job verifies and re-checks; "check" is on demand.
const domainChecks = securityRateLimit({ name: "organization-domain-check", limit: 10, windowMs: 15 * 60_000 });
router.get("/domains", ...manage, listDomains);
router.post("/domains", ...manage, writes, addDomain);
router.post("/domains/:id/check", ...manage, domainChecks, checkDomain);
router.delete("/domains/:id", ...manage, writes, removeDomain);

export default router;
