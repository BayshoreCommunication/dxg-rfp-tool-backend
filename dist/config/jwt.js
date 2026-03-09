"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeToken = exports.verifyAccessToken = exports.generateAccessToken = exports.TOKEN_EXPIRY_MS = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
const JWT_EXPIRE = process.env.JWT_EXPIRE || "30d"; // 30 days
// 30 days in milliseconds
exports.TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
// Generate access token (30 days validity)
const generateAccessToken = (payload) => {
    const accessToken = jsonwebtoken_1.default.sign(payload, JWT_SECRET, {
        expiresIn: JWT_EXPIRE,
    });
    const expiresAt = Date.now() + exports.TOKEN_EXPIRY_MS;
    const expiresIn = Math.floor(exports.TOKEN_EXPIRY_MS / 1000); // Convert to seconds
    return {
        accessToken,
        expiresAt,
        expiresIn,
    };
};
exports.generateAccessToken = generateAccessToken;
// Verify access token
const verifyAccessToken = (token) => {
    try {
        return jsonwebtoken_1.default.verify(token, JWT_SECRET);
    }
    catch (error) {
        throw new Error("Invalid or expired token");
    }
};
exports.verifyAccessToken = verifyAccessToken;
// Decode token without verification (to check expiry)
const decodeToken = (token) => {
    try {
        return jsonwebtoken_1.default.decode(token);
    }
    catch {
        return null;
    }
};
exports.decodeToken = decodeToken;
//# sourceMappingURL=jwt.js.map