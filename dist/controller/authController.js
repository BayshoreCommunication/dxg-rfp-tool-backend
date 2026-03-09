"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signOut = exports.getCurrentUser = exports.signInWithCredentials = exports.signUp = void 0;
const jwt_1 = require("../config/jwt");
const user_1 = __importDefault(require("../modal/user"));
// Sign up with credentials
const signUp = async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;
        // Validation
        if (!name || !email || !password) {
            res.status(400).json({
                success: false,
                message: "Please provide name, email, and password",
            });
            return;
        }
        // Check if user already exists
        const existingUser = await user_1.default.findOne({ email });
        if (existingUser) {
            res.status(400).json({
                success: false,
                message: "User with this email already exists",
            });
            return;
        }
        // Create new user
        const user = await user_1.default.create({
            name,
            email,
            phone,
            password,
        });
        // Generate access token
        const tokenPayload = {
            userId: user._id.toString(),
            email: user.email,
            role: "customer", // Default role for token compatibility
        };
        const tokenData = (0, jwt_1.generateAccessToken)(tokenPayload);
        // User response (without password)
        const userResponse = {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            avatar: user.avatar,
            createdAt: user.createdAt,
        };
        res.status(201).json({
            success: true,
            message: "User registered successfully",
            user: userResponse,
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
// Sign in with credentials
const signInWithCredentials = async (req, res) => {
    try {
        const { email, password } = req.body;
        // Validation
        if (!email || !password) {
            res.status(400).json({
                success: false,
                message: "Please provide email and password",
            });
            return;
        }
        // Find user and include password field
        const user = await user_1.default.findOne({ email }).select("+password");
        if (!user) {
            res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
            return;
        }
        // Verify password
        const isPasswordValid = await user.comparePassword(password);
        if (!isPasswordValid) {
            res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
            return;
        }
        // Generate access token
        const tokenPayload = {
            userId: user._id.toString(),
            email: user.email,
            role: "customer", // Default role for token compatibility
        };
        const tokenData = (0, jwt_1.generateAccessToken)(tokenPayload);
        // User response (without password)
        const userResponse = {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            avatar: user.avatar,
            createdAt: user.createdAt,
        };
        res.status(200).json({
            success: true,
            message: "Login successful",
            user: userResponse,
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
// Get current user
const getCurrentUser = async (req, res) => {
    try {
        const user = await user_1.default.findById(req.user?.userId);
        if (!user) {
            res.status(404).json({
                success: false,
                message: "User not found",
            });
            return;
        }
        const userResponse = {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            avatar: user.avatar,
            createdAt: user.createdAt,
        };
        res.status(200).json({
            success: true,
            user: userResponse,
        });
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
// Sign out
const signOut = async (_req, res) => {
    try {
        res.status(200).json({
            success: true,
            message: "Signed out successfully",
        });
    }
    catch (error) {
        console.error("Sign out error:", error);
        res.status(500).json({
            success: false,
            message: "Error during sign out",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.signOut = signOut;
//# sourceMappingURL=authController.js.map