import { Router } from "express";
import { exchangeSsoHandoff, ssoCallback, startSso } from "../controller/ssoController";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/auth/sso. Microsoft and company-OIDC sign-in round trip.
const router = Router();
const startLimit = securityRateLimit({ name: "sso-start", limit: 30, windowMs: 15 * 60_000 });
const callbackLimit = securityRateLimit({ name: "sso-callback", limit: 30, windowMs: 15 * 60_000 });
const exchangeLimit = securityRateLimit({ name: "sso-exchange", limit: 30, windowMs: 15 * 60_000 });

router.get("/start", startLimit, startSso);
router.get("/callback", callbackLimit, ssoCallback);
router.post("/exchange", exchangeLimit, exchangeSsoHandoff);

export default router;
