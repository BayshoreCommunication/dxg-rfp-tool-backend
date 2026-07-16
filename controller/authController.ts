import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  authenticateGoogleIdentity,
  authenticateWithCredentials,
  getAuthenticatedUserAccount,
  registerCustomerAccount,
  registerAdminAccount,
  requestAuthenticationOtp,
  resetCustomerPassword,
  verifyAuthenticationOtp,
} from "../src/modules/auth/composition";

const applicationUserResponse = (user: {
  id: string;
  name: string;
  email: string;
  role: string;
  phone?: string;
  company?: string;
  avatar?: string;
  createdAt?: Date;
}) => ({
  _id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
  company: user.company,
  avatar: user.avatar,
  createdAt: user.createdAt,
});

/* ─────────────────────────────────────────
   POST /api/auth/send-otp
   Send signup OTP (spam check: reject if user already exists)
───────────────────────────────────────── */
export const sendSignupOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: "Email is required" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    const result = await requestAuthenticationOtp(normalizedEmail, "signup");
    if (result.kind === "account_exists") {
      res.status(409).json({
        success: false,
        message: "An account with this email already exists. Please sign in.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Verification code sent to your email",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Send signup OTP error:", error);
    res.status(500).json({
      success: false,
      message: `Error sending verification code: ${errorMessage}`,
      error: errorMessage,
    });
  }
};

/* ─────────────────────────────────────────
   POST /api/auth/verify-otp
   Verify signup OTP (mark as verified, do not create account yet)
───────────────────────────────────────── */
export const verifySignupOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      res.status(400).json({ success: false, message: "Email and OTP are required" });
      return;
    }

    const result = await verifyAuthenticationOtp(
      email.toLowerCase().trim(),
      otp.trim(),
      "signup",
    );
    if (result.kind === "not_found") {
      res.status(400).json({ success: false, message: "OTP not found or already used. Please request a new one." });
      return;
    }

    if (result.kind === "expired") {
      res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
      return;
    }

    if (result.kind === "invalid") {
      res.status(400).json({ success: false, message: "Invalid OTP. Please try again." });
      return;
    }

    res.status(200).json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    console.error("Verify signup OTP error:", error);
    res.status(500).json({
      success: false,
      message: "Error verifying OTP",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────
   POST /api/auth/register
   Create account (only after OTP verified)
───────────────────────────────────────── */
export const signUp = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await registerCustomerAccount(req.body ?? {});
    if (result.kind === "validation") {
      res.status(400).json({ success: false, message: "Name, email, and password are required" });
      return;
    }
    if (result.kind === "invalid_password") {
      res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      return;
    }
    if (result.kind === "unverified") {
      res.status(403).json({
        success: false,
        message: "Email not verified. Please complete OTP verification first.",
      });
      return;
    }

    if (result.kind === "email_conflict") {
      res.status(409).json({ success: false, message: "User with this email already exists" });
      return;
    }

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: { ...result.user, _id: result.user.id, id: undefined },
      accessToken: result.token.accessToken,
      tokenExpiresAt: result.token.expiresAt,
      tokenExpiresIn: result.token.expiresIn,
    });
  } catch (error) {
    console.error("Sign up error:", error);
    res.status(500).json({
      success: false,
      message: "Error during registration",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────
   POST /api/auth/login
   Sign in with email + password
───────────────────────────────────────── */
export const signInWithCredentials = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await authenticateWithCredentials(req.body ?? {}, "customer");
    if (result.kind === "validation") {
      res.status(400).json({ success: false, message: "Email and password are required" });
      return;
    }

    if (result.kind === "not_found") {
      res.status(404).json({
        success: false,
        message: "No account found with this email. Please create an account first.",
        errorCode: "USER_NOT_FOUND",
      });
      return;
    }

    if (result.kind === "wrong_password") {
      res.status(401).json({
        success: false,
        message: "Incorrect password. Please try again.",
        errorCode: "WRONG_PASSWORD",
      });
      return;
    }

    if (result.kind === "blocked") {
      res.status(403).json({
        success: false,
        message: "Your account has been blocked. Please contact support.",
        errorCode: "USER_BLOCKED",
      });
      return;
    }
    if (result.kind === "not_admin") {
      res.status(403).json({ success: false, message: "This account cannot use customer login." });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Login successful",
      user: applicationUserResponse(result.user),
      accessToken: result.token.accessToken,
      tokenExpiresAt: result.token.expiresAt,
      tokenExpiresIn: result.token.expiresIn,
    });
  } catch (error) {
    console.error("Sign in error:", error);
    res.status(500).json({
      success: false,
      message: "Error during login",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────────
   POST /api/auth/google
   Sign in with Google (create account if not exists)
───────────────────────────────────────────── */
export const signInWithGoogle = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await authenticateGoogleIdentity(req.body?.idToken);
    if (result.kind === "validation") {
      res.status(400).json({ success: false, message: "Google ID token is required" });
      return;
    }
    if (result.kind === "invalid_identity") {
      res.status(401).json({ success: false, message: "Invalid Google identity token" });
      return;
    }
    if (result.kind === "blocked") {
      res.status(403).json({
        success: false,
        message: "Your account has been suspended. Please contact support.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: result.isNewUser
        ? "Google account created and signed in successfully"
        : "Google sign in successful",
      isNewUser: result.isNewUser,
      user: applicationUserResponse(result.user),
      accessToken: result.token.accessToken,
      tokenExpiresAt: result.token.expiresAt,
      tokenExpiresIn: result.token.expiresIn,
    });
  } catch (error) {
    console.error("Google sign in error:", error);
    res.status(500).json({
      success: false,
      message: "Error during Google sign in",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────────
   POST /api/auth/admin/signup
   Create admin account
───────────────────────────────────────────── */
export const signUpAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await registerAdminAccount(
      req.body ?? {},
      process.env.ADMIN_SIGNUP_SECRET,
    );
    if (result.kind === "validation") {
      res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
      return;
    }

    if (result.kind === "invalid_password") {
      res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      return;
    }
    if (result.kind === "invalid_secret") {
      res.status(403).json({
        success: false,
        message: "Invalid admin signup secret.",
      });
      return;
    }

    if (result.kind === "email_conflict") {
      res
        .status(409)
        .json({ success: false, message: "User with this email already exists" });
      return;
    }

    res.status(201).json({
      success: true,
      message: "Admin account created successfully",
      user: applicationUserResponse(result.user),
      accessToken: result.token.accessToken,
      tokenExpiresAt: result.token.expiresAt,
      tokenExpiresIn: result.token.expiresIn,
    });
  } catch (error) {
    console.error("Admin sign up error:", error);
    res.status(500).json({
      success: false,
      message: "Error during admin registration",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────────
   POST /api/auth/admin/signin
   Admin-only sign in
───────────────────────────────────────────── */
export const signInAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await authenticateWithCredentials(req.body ?? {}, "admin");
    if (result.kind === "validation") {
      res.status(400).json({ success: false, message: "Email and password are required" });
      return;
    }

    if (result.kind === "not_found") {
      res.status(404).json({
        success: false,
        message: "No account found with this email.",
        errorCode: "USER_NOT_FOUND",
      });
      return;
    }

    if (result.kind === "wrong_password") {
      res.status(401).json({
        success: false,
        message: "Incorrect password. Please try again.",
        errorCode: "WRONG_PASSWORD",
      });
      return;
    }

    if (result.kind === "not_admin") {
      res.status(403).json({
        success: false,
        message: "This account does not have admin access.",
        errorCode: "NOT_ADMIN",
      });
      return;
    }

    if (result.kind === "blocked") {
      res.status(403).json({
        success: false,
        message: "Your account has been blocked. Please contact support.",
        errorCode: "USER_BLOCKED",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Admin login successful",
      user: applicationUserResponse(result.user),
      accessToken: result.token.accessToken,
      tokenExpiresAt: result.token.expiresAt,
      tokenExpiresIn: result.token.expiresIn,
    });
  } catch (error) {
    console.error("Admin sign in error:", error);
    res.status(500).json({
      success: false,
      message: "Error during admin login",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────
   GET /api/auth/me
   Get current user
───────────────────────────────────────── */
export const getCurrentUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user?.userId
      ? await getAuthenticatedUserAccount(req.user.userId)
      : null;
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.status(200).json({ success: true, user: applicationUserResponse(user) });
  } catch (error) {
    console.error("Get current user error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────
   POST /api/auth/logout
───────────────────────────────────────── */
export const signOut = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: "Signed out successfully" });
};

/* ─────────────────────────────────────────
   POST /api/auth/forgot-password/send-otp
   Request password reset OTP
───────────────────────────────────────── */
export const sendForgotPasswordOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: "Email is required" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    await requestAuthenticationOtp(normalizedEmail, "forgot-password");

    res.status(200).json({
      success: true,
      message: "If an account with this email exists, a reset code has been sent.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Forgot password OTP error:", error);
    res.status(500).json({
      success: false,
      message: `Error sending reset code: ${errorMessage}`,
      error: errorMessage,
    });
  }
};

/* ─────────────────────────────────────────
   POST /api/auth/forgot-password/verify-otp
   Verify the forgot-password OTP
───────────────────────────────────────── */
export const verifyForgotPasswordOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      res.status(400).json({ success: false, message: "Email and OTP are required" });
      return;
    }

    const result = await verifyAuthenticationOtp(
      email.toLowerCase().trim(),
      otp.trim(),
      "forgot-password",
    );
    if (result.kind === "not_found") {
      res.status(400).json({ success: false, message: "OTP not found or already used. Please request a new one." });
      return;
    }

    if (result.kind === "expired") {
      res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
      return;
    }

    if (result.kind === "invalid") {
      res.status(400).json({ success: false, message: "Invalid OTP. Please try again." });
      return;
    }

    res.status(200).json({ success: true, message: "OTP verified. You can now reset your password." });
  } catch (error) {
    console.error("Verify forgot-password OTP error:", error);
    res.status(500).json({
      success: false,
      message: "Error verifying OTP",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/* ─────────────────────────────────────────
   POST /api/auth/forgot-password/reset
   Reset password (only if OTP was verified)
───────────────────────────────────────── */
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await resetCustomerPassword(req.body ?? {});
    if (result.kind === "validation") {
      res.status(400).json({ success: false, message: "Email and new password are required" });
      return;
    }
    if (result.kind === "invalid_password") {
      res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      return;
    }

    if (result.kind === "unauthorized") {
      res.status(403).json({
        success: false,
        message: "Password reset not authorized. Please verify your OTP first.",
      });
      return;
    }

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    res.status(200).json({ success: true, message: "Password reset successfully. You can now sign in." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      success: false,
      message: "Error resetting password",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
