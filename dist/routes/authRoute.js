"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controller/authController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/* ─── Signup flow ─── */
// Step 1: Check email not taken + send OTP
router.post("/send-otp", authController_1.sendSignupOtp);
// Step 2: Verify OTP
router.post("/verify-otp", authController_1.verifySignupOtp);
// Step 3: Create account (only if OTP verified)
router.post("/register", authController_1.signUp);
/* ─── Sign in ─── */
router.post("/login", authController_1.signInWithCredentials);
router.post("/google", authController_1.signInWithGoogle);
router.post("/admin/signin", authController_1.signInAdmin);
/* ─── Forgot password flow ─── */
// Step 1: Send reset OTP
router.post("/forgot-password/send-otp", authController_1.sendForgotPasswordOtp);
// Step 2: Verify reset OTP
router.post("/forgot-password/verify-otp", authController_1.verifyForgotPasswordOtp);
// Step 3: Set new password
router.post("/forgot-password/reset", authController_1.resetPassword);
/* ─── Protected ─── */
router.get("/me", auth_1.authenticate, authController_1.getCurrentUser);
router.post("/logout", auth_1.authenticate, authController_1.signOut);
exports.default = router;
//# sourceMappingURL=authRoute.js.map