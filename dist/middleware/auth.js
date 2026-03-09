"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorize = exports.authenticate = void 0;
const jwt_1 = require("../config/jwt");
const authenticate = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            res.status(401).json({
                success: false,
                message: "No token provided. Authorization required.",
            });
            return;
        }
        const token = authHeader.substring(7); // Remove "Bearer " prefix
        try {
            const decoded = (0, jwt_1.verifyAccessToken)(token);
            req.user = decoded;
            next();
        }
        catch (error) {
            res.status(401).json({
                success: false,
                message: "Invalid or expired token",
            });
            return;
        }
    }
    catch (error) {
        res.status(500).json({
            success: false,
            message: "Authentication error",
        });
        return;
    }
};
exports.authenticate = authenticate;
// Optional: Role-based authorization middleware
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({
                success: false,
                message: "Authentication required",
            });
            return;
        }
        if (!roles.includes(req.user.role)) {
            res.status(403).json({
                success: false,
                message: "You don't have permission to access this resource",
            });
            return;
        }
        next();
    };
};
exports.authorize = authorize;
//# sourceMappingURL=auth.js.map