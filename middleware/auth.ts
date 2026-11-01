import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { TokenPayload, verifyAccessToken } from "../config/jwt";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import RefreshSession from "../modal/refreshSessionModel";
import { runWithTenant } from "../src/modules/shared/tenancy/tenantContext";
import { findSessionPrincipal } from "../src/modules/auth/infrastructure/mongo/mongoSessionAccountLoader";
import { hasOrganizationAction, legacyAuthorizationRoles, OrganizationAction } from "../src/modules/identity/domain/authorizationPolicy";
import type { RfpActor } from "../src/modules/identity/domain/rfpAccessPolicy";
import { ActorLookups, noTeamsOrSharesYet, resolveRfpActor } from "../src/modules/identity/application/resolveRfpActor";
import { authenticationSessions } from "../src/modules/auth/composition";

// Extend Express Request to include user
export interface AuthRequest extends Request {
  user?: TokenPayload;
  // Resolved once per request for rfpAccessPolicy: organization, roles, managed teams, shares.
  rfpActor?: RfpActor;
}

type AuthenticateDependencies = {
  revokeInactiveMembership(input: { userId: string; organizationId: string; correlationId: string }): Promise<number>;
  actorLookups: ActorLookups;
};

const defaultDependencies: AuthenticateDependencies = {
  revokeInactiveMembership: (input) => authenticationSessions.revokeInactiveMembership(input),
  actorLookups: noTeamsOrSharesYet,
};

export const createAuthenticate = (
  verifyToken: (token: string) => TokenPayload,
  dependencies: AuthenticateDependencies = defaultDependencies,
) => async (
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
      const decoded = verifyToken(token);
      if (!decoded.organizationId || !decoded.sessionId) {
        res.status(401).json({ success: false, message: "Session-bound access token required" });
        return;
      }
      const now = new Date();
      const [principal, organization, membership, activeSession] = await Promise.all([
        findSessionPrincipal(decoded.userId, decoded.organizationId),
        Organization.findOne({ _id: decoded.organizationId, status: "active" }).select("_id").lean(),
        // Any status: a deactivated or removed member is told so and signed out below.
        OrganizationMembership.findOne({
          organizationId: decoded.organizationId,
          userId: decoded.userId,
        }).select("roles version status").lean(),
        RefreshSession.exists({
          sessionId: decoded.sessionId,
          userId: decoded.userId,
          organizationId: decoded.organizationId,
          status: "active",
          expiresAt: { $gt: now },
          idleExpiresAt: { $gt: now },
        }),
      ]);
      // Deactivation takes effect on the next request, not at token expiry: refuse with 401 and
      // revoke the member's refresh sessions so the client can't mint a new access token.
      if (!membership || membership.status !== "active") {
        await dependencies.revokeInactiveMembership({
          userId: decoded.userId,
          organizationId: decoded.organizationId,
          correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
        });
        res.status(401).json({
          success: false,
          code: "MEMBERSHIP_INACTIVE",
          message: "Your organization membership is no longer active. Please contact your organization's admin.",
        });
        return;
      }
      if (!principal || !activeSession) {
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
      // The account role comes from the stored account, never the token, so a
      // token minted before an account moved collections or changed role
      // cannot carry stale privileges.
      req.user = {
        ...decoded,
        role: principal.role,
        accountType: principal.accountType,
        organizationId: decoded.organizationId,
        roles: membership.roles,
        rolesVersion: membership.version,
      };
      req.rfpActor = await resolveRfpActor(
        { organizationId: decoded.organizationId, userId: decoded.userId, roles: membership.roles, status: membership.status },
        dependencies.actorLookups,
      );
      runWithTenant({ organizationId: decoded.organizationId, userId: decoded.userId, rfpActor: req.rfpActor }, next);
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

// Both normal access and upload-only tickets recheck current membership,
// blocked users, organization status, roles version, and session revocation.
export const authenticate = createAuthenticate(verifyAccessToken);

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
