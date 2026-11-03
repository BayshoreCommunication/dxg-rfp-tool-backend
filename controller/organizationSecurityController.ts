import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { correlationId } from "./authController";
import { organizationTwoFactorPolicy } from "../src/modules/twoFactor/composition";

/* ORG-304. Mounted under /api/organization behind organization:manage (Owner, Admin).
   The organization is always the caller's session organization, never a parameter. */

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, code, message });

const handleError = (res: Response, error: unknown, context: string) => {
  console.error(`Organization security ${context} error:`, error instanceof Error ? error.name : "unknown");
  fail(res, 500, "ORGANIZATION_SECURITY_ERROR", "Request failed");
};

/* GET /api/organization/security */
export const getOrganizationSecurity = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await organizationTwoFactorPolicy.settings(req.user!.organizationId!);
    res.status(200).json({ success: true, ...settings });
  } catch (error) {
    handleError(res, error, "read");
  }
};

/* PUT /api/organization/security { requireTwoFactor } */
export const updateOrganizationSecurity = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await organizationTwoFactorPolicy.setRequireTwoFactor({
      organizationId: req.user!.organizationId!,
      actorUserId: req.user!.userId,
      requireTwoFactor: req.body?.requireTwoFactor,
      correlationId: correlationId(req),
    });
    if (result.kind === "validation") {
      fail(res, 400, "VALIDATION_ERROR", "requireTwoFactor must be true or false");
      return;
    }
    if (result.kind === "actor_not_enrolled") {
      fail(res, 409, "TWO_FACTOR_REQUIRED_FOR_ACTOR", "Turn on two-factor authentication for your own account before requiring it");
      return;
    }
    res.status(200).json({ success: true, requireTwoFactor: result.requireTwoFactor, signedOutMembers: result.signedOutMembers });
  } catch (error) {
    handleError(res, error, "update");
  }
};

/* POST /api/organization/members/:userId/two-factor/reset */
export const resetMemberTwoFactor = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await organizationTwoFactorPolicy.resetMember({
      organizationId: req.user!.organizationId!,
      actorUserId: req.user!.userId,
      actorRoles: req.user!.roles ?? [],
      targetUserId: String(req.params.userId ?? ""),
      correlationId: correlationId(req),
    });
    if (result.kind === "self") {
      fail(res, 400, "TWO_FACTOR_RESET_SELF", "Use your own security settings to change your two-factor authentication");
      return;
    }
    if (result.kind === "not_found") {
      fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
      return;
    }
    if (result.kind === "forbidden") {
      fail(res, 403, "FORBIDDEN", "Only the Owner can reset the Owner's two-factor authentication");
      return;
    }
    if (result.kind === "member_of_other_organization") {
      fail(res, 409, "TWO_FACTOR_RESET_SHARED_ACCOUNT", "This member also belongs to another organization. Contact support to reset their two-factor authentication.");
      return;
    }
    res.status(200).json({ success: true, wasEnrolled: result.wasEnrolled, revokedSessions: result.revokedSessions });
  } catch (error) {
    handleError(res, error, "reset");
  }
};
