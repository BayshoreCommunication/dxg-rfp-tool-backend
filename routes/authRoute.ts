import { Router } from "express";
import {
  getCurrentUser,
  resetPassword,
  sendForgotPasswordOtp,
  sendSignupOtp,
  signUpAdmin,
  signInAdmin,
  signInWithCredentials,
  signInWithGoogle,
  signOut,
  signUp,
  verifyForgotPasswordOtp,
  verifySignupOtp,
  refreshSession,
  signOutAll,
  listSessions,
  revokeSession,
  signOutSession,
} from "../controller/authController";
import { authenticate } from "../middleware/auth";
import { emailAndIpIdentity, securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const authAttemptLimit = securityRateLimit({ name: "auth-attempt", limit: 10, windowMs: 15 * 60_000, identity: emailAndIpIdentity });
const otpLimit = securityRateLimit({ name: "otp", limit: 5, windowMs: 15 * 60_000, identity: emailAndIpIdentity });
const refreshLimit = securityRateLimit({ name: "refresh", limit: 60, windowMs: 15 * 60_000 });

/* ─── Signup flow ─── */
// Step 1: Check email not taken + send OTP
router.post("/send-otp", otpLimit, sendSignupOtp);
// Step 2: Verify OTP
router.post("/verify-otp", authAttemptLimit, verifySignupOtp);
// Step 3: Create account (only if OTP verified)
router.post("/register", signUp);

/* ─── Sign in ─── */
router.post("/login", authAttemptLimit, signInWithCredentials);
router.post("/google", authAttemptLimit, signInWithGoogle);
// Rate-limited like every other credential endpoint: the route is gated by
// ADMIN_SIGNUP_SECRET, and an unlimited endpoint would let that secret be
// brute-forced offline-fast.
router.post("/admin/signup", authAttemptLimit, signUpAdmin);
router.post("/admin/signin", authAttemptLimit, signInAdmin);
router.post("/refresh", refreshLimit, refreshSession);
router.post("/logout-session", refreshLimit, signOutSession);

/* ─── Forgot password flow ─── */
// Step 1: Send reset OTP
router.post("/forgot-password/send-otp", otpLimit, sendForgotPasswordOtp);
// Step 2: Verify reset OTP
router.post("/forgot-password/verify-otp", authAttemptLimit, verifyForgotPasswordOtp);
// Step 3: Set new password
router.post("/forgot-password/reset", resetPassword);

/* ─── Protected ─── */
router.get("/me", authenticate, getCurrentUser);
router.post("/logout", authenticate, signOut);
router.post("/logout-all", authenticate, signOutAll);
router.get("/sessions", authenticate, listSessions);
router.delete("/sessions/:id", authenticate, revokeSession);

export default router;
