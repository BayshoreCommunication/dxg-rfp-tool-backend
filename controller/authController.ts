import { Request, Response } from "express";
import { randomBytes } from "crypto";
import { generateAccessToken, TokenPayload } from "../config/jwt";
import { AuthRequest } from "../middleware/auth";
import Otp from "../modal/otpModel";
import User from "../modal/userModel";
import {
  generateOtp,
  sendForgotPasswordOtpEmail,
  sendSignupOtpEmail,
} from "../utils/emailService";

/* ─────────────────────────────────────────
   Helper — build safe user response
───────────────────────────────────────── */
const userResponse = (user: any) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
  avatar: user.avatar,
  createdAt: user.createdAt,
});

const isAdminRole = (role?: string): boolean => {
  const normalizedRole = (role || "").toLowerCase().trim();
  return (
    normalizedRole === "admin" ||
    normalizedRole === "superadmin" ||
    normalizedRole === "super_admin"
  );
};

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

    // Spam check - don't allow re-registration
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "An account with this email already exists. Please sign in.",
      });
      return;
    }

    // Invalidate any existing OTPs for this email/type
    await Otp.deleteMany({ email: normalizedEmail, type: "signup" });

    const otp = generateOtp();
    await Otp.create({
      email: normalizedEmail,
      otp,
      type: "signup",
    });

    try {
      await sendSignupOtpEmail(normalizedEmail, otp);
    } catch (sendError) {
      // Roll back OTP when delivery fails to avoid stale codes.
      await Otp.deleteMany({ email: normalizedEmail, type: "signup" });
      throw sendError;
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

    const record = await Otp.findOne({
      email: email.toLowerCase().trim(),
      type: "signup",
      verified: false,
    });

    if (!record) {
      res.status(400).json({ success: false, message: "OTP not found or already used. Please request a new one." });
      return;
    }

    if (new Date() > record.expiresAt) {
      await record.deleteOne();
      res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
      return;
    }

    if (record.otp !== otp.trim()) {
      res.status(400).json({ success: false, message: "Invalid OTP. Please try again." });
      return;
    }

    // Mark as verified (frontend can now proceed to registration form)
    record.verified = true;
    await record.save();

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
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ success: false, message: "Name, email, and password are required" });
      return;
    }

    // Confirm OTP was verified for this email
    const otpRecord = await Otp.findOne({
      email: email.toLowerCase().trim(),
      type: "signup",
      verified: true,
    });

    if (!otpRecord) {
      res.status(403).json({
        success: false,
        message: "Email not verified. Please complete OTP verification first.",
      });
      return;
    }

    // Double-check user doesn't exist
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      res.status(409).json({ success: false, message: "User with this email already exists" });
      return;
    }

    const user = await User.create({ name, email, phone, password });

    // Clean up OTP record
    await otpRecord.deleteOne();

    const tokenPayload: TokenPayload = {
      userId: user._id.toString(),
      email: user.email,
      role: "customer",
    };
    const tokenData = generateAccessToken(tokenPayload);

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: userResponse(user),
      accessToken: tokenData.accessToken,
      tokenExpiresAt: tokenData.expiresAt,
      tokenExpiresIn: tokenData.expiresIn,
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
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, message: "Email and password are required" });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+password");

    if (!user || !(await user.comparePassword(password))) {
      res.status(401).json({ success: false, message: "Invalid email or password" });
      return;
    }

    const tokenPayload: TokenPayload = {
      userId: user._id.toString(),
      email: user.email,
      role: "customer",
    };
    const tokenData = generateAccessToken(tokenPayload);

    res.status(200).json({
      success: true,
      message: "Login successful",
      user: userResponse(user),
      accessToken: tokenData.accessToken,
      tokenExpiresAt: tokenData.expiresAt,
      tokenExpiresIn: tokenData.expiresIn,
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
    const { email, name, avatar, googleId } = req.body as {
      email?: string;
      name?: string;
      avatar?: string;
      googleId?: string;
    };

    if (!email || !email.trim()) {
      res.status(400).json({ success: false, message: "Email is required" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const trimmedName = (name || "").trim();
    const trimmedAvatar = (avatar || "").trim();
    const trimmedGoogleId = (googleId || "").trim();

    let user = await User.findOne({ email: normalizedEmail });
    let isNewUser = false;

    if (!user) {
      const fallbackName = normalizedEmail.split("@")[0] || "Google User";
      const generatedPassword = randomBytes(24).toString("hex");

      user = await User.create({
        name: trimmedName || fallbackName,
        email: normalizedEmail,
        avatar: trimmedAvatar || undefined,
        password: generatedPassword,
        googleId: trimmedGoogleId || undefined,
      });
      isNewUser = true;
    } else {
      let shouldSave = false;

      if (trimmedAvatar && user.avatar !== trimmedAvatar) {
        user.avatar = trimmedAvatar;
        shouldSave = true;
      }

      if (trimmedName && (!user.name || user.name.trim() !== trimmedName)) {
        user.name = trimmedName;
        shouldSave = true;
      }

      if (trimmedGoogleId && user.googleId !== trimmedGoogleId) {
        user.googleId = trimmedGoogleId;
        shouldSave = true;
      }

      if (shouldSave) {
        await user.save();
      }
    }

    const tokenPayload: TokenPayload = {
      userId: user._id.toString(),
      email: user.email,
      role: String((user as any).role || "customer"),
    };
    const tokenData = generateAccessToken(tokenPayload);

    res.status(200).json({
      success: true,
      message: isNewUser
        ? "Google account created and signed in successfully"
        : "Google sign in successful",
      isNewUser,
      user: userResponse(user),
      accessToken: tokenData.accessToken,
      tokenExpiresAt: tokenData.expiresAt,
      tokenExpiresIn: tokenData.expiresIn,
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
    const { name, email, phone, password, adminSecret } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
      return;
    }

    const requiredSecret = process.env.ADMIN_SIGNUP_SECRET;
    if (
      requiredSecret &&
      String(adminSecret || "").trim() !== String(requiredSecret).trim()
    ) {
      res.status(403).json({
        success: false,
        message: "Invalid admin signup secret.",
      });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      res
        .status(409)
        .json({ success: false, message: "User with this email already exists" });
      return;
    }

    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      phone: phone ? String(phone).trim() : undefined,
      password: String(password),
      role: "admin",
    });

    const tokenPayload: TokenPayload = {
      userId: user._id.toString(),
      email: user.email,
      role: "admin",
    };
    const tokenData = generateAccessToken(tokenPayload);

    res.status(201).json({
      success: true,
      message: "Admin account created successfully",
      user: userResponse(user),
      accessToken: tokenData.accessToken,
      tokenExpiresAt: tokenData.expiresAt,
      tokenExpiresIn: tokenData.expiresIn,
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
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, message: "Email and password are required" });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+password");

    if (!user || !(await user.comparePassword(password))) {
      res.status(401).json({ success: false, message: "Invalid email or password" });
      return;
    }

    const role = String((user as any).role || "");
    if (!isAdminRole(role)) {
      res.status(403).json({
        success: false,
        message: "Access denied. Admin account required.",
      });
      return;
    }

    const tokenPayload: TokenPayload = {
      userId: user._id.toString(),
      email: user.email,
      role: role || "admin",
    };
    const tokenData = generateAccessToken(tokenPayload);

    res.status(200).json({
      success: true,
      message: "Admin login successful",
      user: userResponse(user),
      accessToken: tokenData.accessToken,
      tokenExpiresAt: tokenData.expiresAt,
      tokenExpiresIn: tokenData.expiresIn,
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
    const user = await User.findById(req.user?.userId);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.status(200).json({ success: true, user: userResponse(user) });
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

    const user = await User.findOne({ email: normalizedEmail });
    // Security: don't reveal whether account exists
    if (!user) {
      res.status(200).json({
        success: true,
        message: "If an account with this email exists, a reset code has been sent.",
      });
      return;
    }

    // Invalidate existing forgot-password OTPs
    await Otp.deleteMany({ email: normalizedEmail, type: "forgot-password" });

    const otp = generateOtp();
    await Otp.create({
      email: normalizedEmail,
      otp,
      type: "forgot-password",
    });

    try {
      await sendForgotPasswordOtpEmail(normalizedEmail, otp);
    } catch (sendError) {
      await Otp.deleteMany({ email: normalizedEmail, type: "forgot-password" });
      throw sendError;
    }

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

    const record = await Otp.findOne({
      email: email.toLowerCase().trim(),
      type: "forgot-password",
      verified: false,
    });

    if (!record) {
      res.status(400).json({ success: false, message: "OTP not found or already used. Please request a new one." });
      return;
    }

    if (new Date() > record.expiresAt) {
      await record.deleteOne();
      res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
      return;
    }

    if (record.otp !== otp.trim()) {
      res.status(400).json({ success: false, message: "Invalid OTP. Please try again." });
      return;
    }

    record.verified = true;
    await record.save();

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
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      res.status(400).json({ success: false, message: "Email and new password are required" });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      return;
    }

    // Confirm OTP was verified
    const otpRecord = await Otp.findOne({
      email: email.toLowerCase().trim(),
      type: "forgot-password",
      verified: true,
    });

    if (!otpRecord) {
      res.status(403).json({
        success: false,
        message: "Password reset not authorized. Please verify your OTP first.",
      });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+password");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    user.password = newPassword; // bcrypt pre-save hook will hash it
    await user.save();

    // Clean up OTP
    await otpRecord.deleteOne();

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

