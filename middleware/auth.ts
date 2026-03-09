import { NextFunction, Request, Response } from "express";
import { TokenPayload, verifyAccessToken } from "../config/jwt";

// Extend Express Request to include user
export interface AuthRequest extends Request {
  user?: TokenPayload;
}

export const authenticate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
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
      const decoded = verifyAccessToken(token);
      req.user = decoded;
      next();
    } catch (error) {
      res.status(401).json({
        success: false,
        message: "Invalid or expired token",
      });
      return;
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Authentication error",
    });
    return;
  }
};

// Optional: Role-based authorization middleware
export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
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
