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
import { ActorLookups, resolveRfpActor } from "../src/modules/identity/application/resolveRfpActor";
import { mongoActorLookups } from "../src/modules/identity/application/mongoActorLookups";
import { endSessionsOfBlockedOrganization, revokeInactiveMembershipSessions, revokeOtherSessionsAfterMembershipChange } from "../src/modules/auth/composition";
import { ORGANIZATION_BLOCKED, isOrganizationBlocked } from "../src/modules/organizationBlock/domain";
import { ORGANIZATION_SETUP_REQUIRED } from "../src/modules/auth/infrastructure/mongo/organizationSetup";

// Extend Express Request to include user
export interface AuthRequest extends Request {
  user?: TokenPayload;
  // Resolved once per request for rfpAccessPolicy: organization, roles, managed teams, shares.
  rfpActor?: RfpActor;
}

type AuthenticateDependencies = {
  revokeInactiveMembership(input: { userId: string; organizationId: string; correlationId: string; reason?: string }): Promise<number>;
  // ORG-307: the member's role was changed by someone else; keep this session, end the others.
  revokeOtherSessionsAfterRoleChange(input: { userId: string; organizationId: string; sessionId: string; correlationId: string }): Promise<number>;
  actorLookups: ActorLookups;
  // The organization is blocked by RFPilot staff: end this member's sessions for it, writing
  // nothing to the organization's audit trail. Optional so existing callers keep their shape.
  endSessionsOfBlockedOrganization?(input: { userId: string; organizationId: string }): Promise<number>;
};

const defaultDependencies: AuthenticateDependencies = {
  revokeInactiveMembership: (input) => revokeInactiveMembershipSessions(input),
  revokeOtherSessionsAfterRoleChange: (input) => revokeOtherSessionsAfterMembershipChange(input),
  actorLookups: mongoActorLookups,
  endSessionsOfBlockedOrganization: (input) => endSessionsOfBlockedOrganization(input),
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
        Organization.findOne({ _id: decoded.organizationId, status: "active" }).select("_id kind blocked").lean(),
        // Any status: a deactivated or removed member is told so and signed out below.
        OrganizationMembership.findOne({
          organizationId: decoded.organizationId,
          userId: decoded.userId,
        }).select("roles version status sessionRevocationPending").lean(),
        RefreshSession.exists({
          sessionId: decoded.sessionId,
          userId: decoded.userId,
          organizationId: decoded.organizationId,
          status: "active",
          expiresAt: { $gt: now },
          idleExpiresAt: { $gt: now },
        }),
      ]);
      /* RFPilot staff blocked this organization (owner decision, 2026-11-18): every request of
         its members is refused, whatever their role, before anything else is decided for them.
         The one rule is isOrganizationBlocked; the organization document is the one this request
         reads anyway, so a block applies on the next request with no cache to wait for. 401 with
         a code, like the two refusals below, so the client drops the session and can say why.
         The member's sessions for THIS organization end (the block ended them already; this
         closes one begun while it committed) and nothing is written to the organization's audit
         trail. First on purpose: none of the customer-side revocation events below may be
         written because of a block. A staff account is never in a blocked organization. */
      if (isOrganizationBlocked(organization)) {
        try {
          await dependencies.endSessionsOfBlockedOrganization?.({ userId: decoded.userId, organizationId: decoded.organizationId });
        } catch (failure) {
          // The refusal stands either way; the refresh path refuses a blocked organization too.
          console.error("Organization block error: a session could not be ended:", failure instanceof Error ? failure.message : failure);
        }
        res.status(401).json({ success: false, code: ORGANIZATION_BLOCKED.code, message: ORGANIZATION_BLOCKED.message });
        return;
      }
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
      // A legacy account still waiting for DXG to place it (ORG-110) can't use a session, including
      // one issued before this rule: end them all so the dashboard signs the person out and shows
      // why at the next sign-in.
      if (organization?.kind === "legacy_holding") {
        await dependencies.revokeInactiveMembership({
          userId: decoded.userId,
          organizationId: decoded.organizationId,
          correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
          reason: "organization_setup_required",
        });
        res.status(401).json({ success: false, code: ORGANIZATION_SETUP_REQUIRED.code, message: ORGANIZATION_SETUP_REQUIRED.message });
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
      // Roles always come from the membership, never the token, so a role change applies on this
      // request with no sign-out (ORG-307); the token's rolesVersion is informational only.
      const correlationId = (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID();
      if (membership.sessionRevocationPending) {
        await dependencies.revokeOtherSessionsAfterRoleChange({
          userId: decoded.userId, organizationId: decoded.organizationId, sessionId: decoded.sessionId, correlationId,
        });
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
