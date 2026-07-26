import { NextFunction, Request, Response } from "express";
import { TokenPayload, verifyAccessToken } from "../config/jwt";
import Organization from "../modal/organizationModel";
import User from "../modal/userModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import RefreshSession from "../modal/refreshSessionModel";
import { runWithTenant } from "../src/modules/shared/tenancy/tenantContext";
import { hasOrganizationAction, legacyAuthorizationRoles, OrganizationAction } from "../src/modules/identity/domain/authorizationPolicy";

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
      if (!decoded.organizationId || !decoded.sessionId) {
        res.status(401).json({ success: false, message: "Session-bound access token required" });
        return;
      }
      const now = new Date();
      const [user, organization, membership, activeSession] = await Promise.all([
        User.findOne({ _id: decoded.userId, organizationId: decoded.organizationId })
          .select("organizationId isBlocked")
          .lean(),
        Organization.findOne({ _id: decoded.organizationId, status: "active" }).select("_id").lean(),
        OrganizationMembership.findOne({
          organizationId: decoded.organizationId,
          userId: decoded.userId,
          status: "active",
        }).select("roles version").lean(),
        RefreshSession.exists({
          sessionId: decoded.sessionId,
          userId: decoded.userId,
          organizationId: decoded.organizationId,
          status: "active",
          expiresAt: { $gt: now },
          idleExpiresAt: { $gt: now },
        }),
      ]);
      if (!user || user.isBlocked || !user.organizationId || !membership || !activeSession) {
        res.status(403).json({ success: false, message: "Active organization membership required" });
        return;
      }
      if (!organization) {
        res.status(403).json({ success: false, message: "Organization is inactive or unavailable" });
        return;
      }
      if (decoded.rolesVersion !== membership.version) {
        res.status(401).json({ success: false, message: "Session authorization is stale" });
        return;
      }
      req.user = {
        ...decoded,
        organizationId: String(user.organizationId),
        roles: membership.roles,
        rolesVersion: membership.version,
      };
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
export const authorize = (...roles: string[]) => {
  const allowedMembershipRoles = roles.flatMap(legacyAuthorizationRoles);
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    if (!req.user.roles?.some((role) => allowedMembershipRoles.includes(role))) {
      res.status(403).json({
        success: false,
        message: "You don't have permission to access this resource",
      });
      return;
    }

    next();
  };
};

export const authorizeAction = (action: OrganizationAction) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    if (!hasOrganizationAction(req.user.roles ?? [], action)) {
      res.status(403).json({ success: false, message: "You don't have permission to perform this action" });
      return;
    }
    next();
  };
