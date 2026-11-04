import { Router } from "express";
import {
  deleteSsoConnection,
  getSsoSettings,
  saveSsoConnection,
  setRequireSso,
  setSsoStatus,
  testSsoConnection,
} from "../controller/ssoController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/organization. The organization's company-OIDC connection; Owner and Admin only.
const router = Router();
const manage = [authenticate, authorizeAction("organization:manage")];
const writes = securityRateLimit({ name: "organization-sso-write", limit: 30, windowMs: 15 * 60_000 });
const tests = securityRateLimit({ name: "organization-sso-test", limit: 10, windowMs: 15 * 60_000 });

router.get("/sso", ...manage, getSsoSettings);
router.put("/sso", ...manage, writes, saveSsoConnection);
router.post("/sso/test", ...manage, tests, testSsoConnection);
router.put("/sso/status", ...manage, writes, setSsoStatus);
router.put("/sso/require", ...manage, writes, setRequireSso);
router.delete("/sso", ...manage, writes, deleteSsoConnection);

export default router;
