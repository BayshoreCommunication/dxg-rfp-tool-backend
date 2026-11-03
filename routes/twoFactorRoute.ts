import { Router, Request } from "express";
import {
  completeTwoFactorChallenge,
  confirmChallengeEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  startChallengeEnrolment,
  startEnrolment,
} from "../controller/twoFactorController";
import { authenticate, AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

// Mounted at /api/auth/2fa. Brute force is held by the shared limiter at three levels:
// per challenge token, per IP, and (in the service) a per-account lock after 10 failures.
const router = Router();
const challengeIdentity = (req: Request) => `${req.ip}:${String(req.body?.challengeToken ?? "")}`;
const userIdentity = (req: Request) => `${req.ip}:${(req as AuthRequest).user?.userId ?? ""}`;
const perChallenge = securityRateLimit({ name: "2fa-challenge", limit: 10, windowMs: 15 * 60_000, identity: challengeIdentity });
const perIp = securityRateLimit({ name: "2fa-ip", limit: 30, windowMs: 15 * 60_000 });
const perUser = securityRateLimit({ name: "2fa-user", limit: 10, windowMs: 15 * 60_000, identity: userIdentity });

/* Pre-session: the challenge token from /api/auth/login or /api/auth/google */
router.post("/challenge", perIp, perChallenge, completeTwoFactorChallenge);
router.post("/enrolment/start", perIp, perChallenge, startChallengeEnrolment);
router.post("/enrolment/confirm", perIp, perChallenge, confirmChallengeEnrolment);

/* Signed in */
router.get("/status", authenticate, getTwoFactorStatus);
router.post("/enrol/start", authenticate, perUser, startEnrolment);
router.post("/enrol/confirm", authenticate, perUser, confirmEnrolment);
router.post("/disable", authenticate, perUser, disableTwoFactor);
router.post("/recovery-codes", authenticate, perUser, regenerateRecoveryCodes);

export default router;
