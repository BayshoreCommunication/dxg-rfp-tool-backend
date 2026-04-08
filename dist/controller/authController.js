"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetPassword = exports.verifyForgotPasswordOtp = exports.sendForgotPasswordOtp = exports.signOut = exports.getCurrentUser = exports.signInAdmin = exports.signInWithCredentials = exports.signUp = exports.verifySignupOtp = exports.sendSignupOtp = void 0;
const jwt_1 = require("../config/jwt");
const otpModel_1 = __importDefault(require("../modal/otpModel"));
const userModel_1 = __importDefault(require("../modal/userModel"));
const emailService_1 = require("../utils/emailService");
/* ─────────────────────────────────────────
   Helper — build safe user response
───────────────────────────────────────── */
const userResponse = (user) => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    avatar: user.avatar,
    createdAt: user.createdAt,
});
const isAdminRole = (role) => {
    const normalizedRole = (role || "").toLowerCase().trim();
    return (normalizedRole === "admin" ||
        normalizedRole === "superadmin" ||
        normalizedRole === "super_admin");
};
/* ─────────────────────────────────────────
   POST /api/auth/send-otp
   Send signup OTP (spam check: reject if user already exists)
───────────────────────────────────────── */
const sendSignupOtp = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            res.status(400).json({ success: false, message: "Email is required" });
            return;
        }
        const normalizedEmail = email.toLowerCase().trim();
        // Spam check - don't allow re-registration
        const existingUser = await userModel_1.default.findOne({ email: normalizedEmail });
        if (existingUser) {
            res.status(409).json({
                success: false,
                message: "An account with this email already exists. Please sign in.",
            });
            return;
        }
        // Invalidate any existing OTPs for this email/type
        await otpModel_1.default.deleteMany({ email: normalizedEmail, type: "signup" });
        const otp = (0, emailService_1.generateOtp)();
        await otpModel_1.default.create({
            email: normalizedEmail,
            otp,
            type: "signup",
        });
        try {
            await (0, emailService_1.sendSignupOtpEmail)(normalizedEmail, otp);
        }
        catch (sendError) {
            // Roll back OTP when delivery fails to avoid stale codes.
            await otpModel_1.default.deleteMany({ email: normalizedEmail, type: "signup" });
            throw sendError;
        }
        res.status(200).json({
            success: true,
            message: "Verification code sent to your email",
        });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error("Send signup OTP error:", error);
        res.status(500).json({
            success: false,
            message: `Error sending verification code: ${errorMessage}`,
            error: errorMessage,
        });
    }
};
exports.sendSignupOtp = sendSignupOtp;
/* ─────────────────────────────────────────
   POST /api/auth/verify-otp
   Verify signup OTP (mark as verified, do not create account yet)
───────────────────────────────────────── */
const verifySignupOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            res.status(400).json({ success: false, message: "Email and OTP are required" });
            return;
        }
        const record = await otpModel_1.default.findOne({
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
    }
    catch (error) {
        console.error("Verify signup OTP error:", error);
        res.status(500).json({
            success: false,
            message: "Error verifying OTP",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.verifySignupOtp = verifySignupOtp;
/* ─────────────────────────────────────────
   POST /api/auth/register
   Create account (only after OTP verified)
───────────────────────────────────────── */
const signUp = async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;
        if (!name || !email || !password) {
            res.status(400).json({ success: false, message: "Name, email, and password are required" });
            return;
        }
        // Confirm OTP was verified for this email
        const otpRecord = await otpModel_1.default.findOne({
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
        const existingUser = await userModel_1.default.findOne({ email: email.toLowerCase().trim() });
        if (existingUser) {
            res.status(409).json({ success: false, message: "User with this email already exists" });
            return;
        }
        const user = await userModel_1.default.create({ name, email, phone, password });
        // Clean up OTP record
        await otpRecord.deleteOne();
        const tokenPayload = {
            userId: user._id.toString(),
            email: user.email,
            role: "customer",
        };
        const tokenData = (0, jwt_1.generateAccessToken)(tokenPayload);
        res.status(201).json({
            success: true,
            message: "Account created successfully",
            user: userResponse(user),
            accessToken: tokenData.accessToken,
            tokenExpiresAt: tokenData.expiresAt,
            tokenExpiresIn: tokenData.expiresIn,
        });
    }
    catch (error) {
        console.error("Sign up error:", error);
        res.status(500).json({
            success: false,
            message: "Error during registration",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.signUp = signUp;
/* ─────────────────────────────────────────
   POST /api/auth/login
   Sign in with email + password
───────────────────────────────────────── */
const signInWithCredentials = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            res.status(400).json({ success: false, message: "Email and password are required" });
            return;
        }
        const user = await userModel_1.default.findOne({ email: email.toLowerCase().trim() }).select("+password");
        if (!user || !(await user.comparePassword(password))) {
            res.status(401).json({ success: false, message: "Invalid email or password" });
            return;
        }
        const tokenPayload = {
            userId: user._id.toString(),
            email: user.email,
            role: "customer",
        };
        const tokenData = (0, jwt_1.generateAccessToken)(tokenPayload);
        res.status(200).json({
            success: true,
            message: "Login successful",
            user: userResponse(user),
            accessToken: tokenData.accessToken,
            tokenExpiresAt: tokenData.expiresAt,
            tokenExpiresIn: tokenData.expiresIn,
        });
    }
    catch (error) {
        console.error("Sign in error:", error);
        res.status(500).json({
            success: false,
            message: "Error during login",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.signInWithCredentials = signInWithCredentials;
/* ─────────────────────────────────────────────
   POST /api/auth/admin/signin
   Admin-only sign in
───────────────────────────────────────────── */
const signInAdmin = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            res.status(400).json({ success: false, message: "Email and password are required" });
            return;
        }
        const user = await userModel_1.default.findOne({ email: email.toLowerCase().trim() }).select("+password");
        if (!user || !(await user.comparePassword(password))) {
            res.status(401).json({ success: false, message: "Invalid email or password" });
            return;
        }
        const role = String(user.role || "");
        if (!isAdminRole(role)) {
            res.status(403).json({
                success: false,
                message: "Access denied. Admin account required.",
            });
            return;
        }
        const tokenPayload = {
            userId: user._id.toString(),
            email: user.email,
            role: role || "admin",
        };
        const tokenData = (0, jwt_1.generateAccessToken)(tokenPayload);
        res.status(200).json({
            success: true,
            message: "Admin login successful",
            user: userResponse(user),
            accessToken: tokenData.accessToken,
            tokenExpiresAt: tokenData.expiresAt,
            tokenExpiresIn: tokenData.expiresIn,
        });
    }
    catch (error) {
        console.error("Admin sign in error:", error);
        res.status(500).json({
            success: false,
            message: "Error during admin login",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.signInAdmin = signInAdmin;
/* ─────────────────────────────────────────
   GET /api/auth/me
   Get current user
───────────────────────────────────────── */
const getCurrentUser = async (req, res) => {
    try {
        const user = await userModel_1.default.findById(req.user?.userId);
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        res.status(200).json({ success: true, user: userResponse(user) });
    }
    catch (error) {
        console.error("Get current user error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching user",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getCurrentUser = getCurrentUser;
/* ─────────────────────────────────────────
   POST /api/auth/logout
───────────────────────────────────────── */
const signOut = async (_req, res) => {
    res.status(200).json({ success: true, message: "Signed out successfully" });
};
exports.signOut = signOut;
/* ─────────────────────────────────────────
   POST /api/auth/forgot-password/send-otp
   Request password reset OTP
───────────────────────────────────────── */
const sendForgotPasswordOtp = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            res.status(400).json({ success: false, message: "Email is required" });
            return;
        }
        const normalizedEmail = email.toLowerCase().trim();
        const user = await userModel_1.default.findOne({ email: normalizedEmail });
        // Security: don't reveal whether account exists
        if (!user) {
            res.status(200).json({
                success: true,
                message: "If an account with this email exists, a reset code has been sent.",
            });
            return;
        }
        // Invalidate existing forgot-password OTPs
        await otpModel_1.default.deleteMany({ email: normalizedEmail, type: "forgot-password" });
        const otp = (0, emailService_1.generateOtp)();
        await otpModel_1.default.create({
            email: normalizedEmail,
            otp,
            type: "forgot-password",
        });
        try {
            await (0, emailService_1.sendForgotPasswordOtpEmail)(normalizedEmail, otp);
        }
        catch (sendError) {
            await otpModel_1.default.deleteMany({ email: normalizedEmail, type: "forgot-password" });
            throw sendError;
        }
        res.status(200).json({
            success: true,
            message: "If an account with this email exists, a reset code has been sent.",
        });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error("Forgot password OTP error:", error);
        res.status(500).json({
            success: false,
            message: `Error sending reset code: ${errorMessage}`,
            error: errorMessage,
        });
    }
};
exports.sendForgotPasswordOtp = sendForgotPasswordOtp;
/* ─────────────────────────────────────────
   POST /api/auth/forgot-password/verify-otp
   Verify the forgot-password OTP
───────────────────────────────────────── */
const verifyForgotPasswordOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            res.status(400).json({ success: false, message: "Email and OTP are required" });
            return;
        }
        const record = await otpModel_1.default.findOne({
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
    }
    catch (error) {
        console.error("Verify forgot-password OTP error:", error);
        res.status(500).json({
            success: false,
            message: "Error verifying OTP",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.verifyForgotPasswordOtp = verifyForgotPasswordOtp;
/* ─────────────────────────────────────────
   POST /api/auth/forgot-password/reset
   Reset password (only if OTP was verified)
───────────────────────────────────────── */
const resetPassword = async (req, res) => {
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
        const otpRecord = await otpModel_1.default.findOne({
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
        const user = await userModel_1.default.findOne({ email: email.toLowerCase().trim() }).select("+password");
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        user.password = newPassword; // bcrypt pre-save hook will hash it
        await user.save();
        // Clean up OTP
        await otpRecord.deleteOne();
        res.status(200).json({ success: true, message: "Password reset successfully. You can now sign in." });
    }
    catch (error) {
        console.error("Reset password error:", error);
        res.status(500).json({
            success: false,
            message: "Error resetting password",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.resetPassword = resetPassword;
//# sourceMappingURL=authController.js.map