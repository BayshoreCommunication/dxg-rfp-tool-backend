import { Router } from "express";
import {
  getCurrentUser,
  resetPassword,
  sendForgotPasswordOtp,
  sendSignupOtp,
  signInAdmin,
  signInWithCredentials,
  signOut,
  signUp,
  verifyForgotPasswordOtp,
  verifySignupOtp,
} from "../controller/authController";
import { authenticate } from "../middleware/auth";

const router = Router();

/* ─── Signup flow ─── */
// Step 1: Check email not taken + send OTP
router.post("/send-otp", sendSignupOtp);
// Step 2: Verify OTP
router.post("/verify-otp", verifySignupOtp);
// Step 3: Create account (only if OTP verified)
router.post("/register", signUp);

/* ─── Sign in ─── */
router.post("/login", signInWithCredentials);
router.post("/admin/signin", signInAdmin);

/* ─── Forgot password flow ─── */
// Step 1: Send reset OTP
router.post("/forgot-password/send-otp", sendForgotPasswordOtp);
// Step 2: Verify reset OTP
router.post("/forgot-password/verify-otp", verifyForgotPasswordOtp);
// Step 3: Set new password
router.post("/forgot-password/reset", resetPassword);

/* ─── Protected ─── */
router.get("/me", authenticate, getCurrentUser);
router.post("/logout", authenticate, signOut);

export default router;
