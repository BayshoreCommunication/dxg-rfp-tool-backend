import { Request, Router } from "express";
import { isAuthorizedBff } from "../controller/authController";
import { discoverSignIn, exchangeSsoHandoff, ssoCallback, startSso } from "../controller/ssoController";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/auth/sso. Microsoft and company-OIDC sign-in round trip.
const router = Router();
const startLimit = securityRateLimit({ name: "sso-start", limit: 30, windowMs: 15 * 60_000 });
const callbackLimit = securityRateLimit({ name: "sso-callback", limit: 30, windowMs: 15 * 60_000 });
const exchangeLimit = securityRateLimit({ name: "sso-exchange", limit: 30, windowMs: 15 * 60_000 });

/* The dashboard calls discover server-side, so req.ip is the dashboard's. It passes the
   visitor's IP in x-rfpilot-client-ip, which is trusted only with a valid BFF key. */
export const discoverIdentity = (req: Request): string => {
  const forwarded = req.headers["x-rfpilot-client-ip"];
  if (typeof forwarded === "string" && forwarded.trim() && isAuthorizedBff(req)) return `client:${forwarded.trim().slice(0, 64)}`;
  return req.ip || "unknown";
};
const discoverLimit = securityRateLimit({ name: "sso-discover", limit: 30, windowMs: 15 * 60_000, identity: discoverIdentity });

router.post("/discover", discoverLimit, discoverSignIn);
router.get("/start", startLimit, startSso);
router.get("/callback", callbackLimit, ssoCallback);
router.post("/exchange", exchangeLimit, exchangeSsoHandoff);

export default router;
