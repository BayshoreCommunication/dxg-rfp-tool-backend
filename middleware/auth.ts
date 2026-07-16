import { NextFunction, Request, Response } from "express";
import { TokenPayload, verifyAccessToken } from "../config/jwt";
import Organization from "../modal/organizationModel";
import User from "../modal/userModel";
import { runWithTenant } from "../src/modules/shared/tenancy/tenantContext";

// Extend Express Request to include user
export interface AuthRequest extends Request {
  user?: TokenPayload;
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
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
      const user = await User.findById(decoded.userId).select("organizationId isBlocked").lean();
      if (!user || user.isBlocked || !user.organizationId) {
        res.status(403).json({ success: false, message: "Active organization membership required" });
        return;
      }
      const organization = await Organization.findOne({ _id: user.organizationId, status: "active" }).select("_id").lean();
      if (!organization) {
        res.status(403).json({ success: false, message: "Organization is inactive or unavailable" });
        return;
      }
      req.user = { ...decoded, organizationId: String(user.organizationId) };
      runWithTenant({ organizationId: String(user.organizationId), userId: decoded.userId }, next);
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
const normalizeRole = (role?: string) =>
  String(role || "").toLowerCase().trim().replace(/[\s-]/g, "_");

export const authorize = (...roles: string[]) => {
  const normalized = roles.map(normalizeRole);
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    if (!normalized.includes(normalizeRole(req.user.role))) {
      res.status(403).json({
        success: false,
        message: "You don't have permission to access this resource",
      });
      return;
    }

    next();
  };
};
