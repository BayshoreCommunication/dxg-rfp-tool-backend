import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import type { PlanStaff } from "../src/modules/entitlements/application/manageOrganizationPlans";
import type { StaffMemberManagement } from "../src/modules/staffAccess/application/manageOrganizationMembers";
import { staffMemberManagement as defaultManagement } from "../src/modules/staffAccess/composition";
import { StaffAccessError, StaffMemberError } from "../src/modules/staffAccess/domain";

// Staff member management (owner decision, 2026-11-18; docs/DECISIONS.md). Members only: there
// is no handler here that touches a proposal's content, a template or the vendor list.

// Role and account type come from the stored account (set by authenticate), never the token.
const staffFrom = (req: AuthRequest): PlanStaff => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) throw new StaffAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    adminId: user.userId,
    organizationId: user.organizationId,
    role: user.role,
    accountType: user.accountType,
    correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
  };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof StaffMemberError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message, ...(error.details ?? {}) });
    return;
  }
  if (error instanceof StaffAccessError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Staff member management error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "STAFF_MEMBERS_INTERNAL_ERROR", message: "The member change could not be completed." });
};

export const createAdminOrganizationMembersController = (management: StaffMemberManagement = defaultManagement) => {
  const handle = (run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(200).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  // The organization and the member always come from the path, never from the session or the body.
  const organization = (req: AuthRequest) => String(req.params.organizationId ?? "");
  const member = (req: AuthRequest) => String(req.params.userId ?? "");
  return {
    member: handle((req) => management.member(staffFrom(req), organization(req), member(req))),
    changeRole: handle((req) => {
      const input = body(req);
      return management.changeRole(staffFrom(req), organization(req), member(req), { role: input.role, version: input.version, reason: input.reason });
    }),
    deactivate: handle((req) => {
      const input = body(req);
      return management.deactivate(staffFrom(req), organization(req), member(req), { version: input.version, reason: input.reason });
    }),
    reactivate: handle((req) => {
      const input = body(req);
      return management.reactivate(staffFrom(req), organization(req), member(req), { version: input.version, reason: input.reason });
    }),
    reassignRfps: handle((req) => {
      const input = body(req);
      return management.reassignRfps(staffFrom(req), organization(req), member(req), { toUserId: input.toUserId, rfpIds: input.rfpIds, reason: input.reason });
    }),
    transferOwnership: handle((req) => {
      const input = body(req);
      return management.transferOwnership(staffFrom(req), organization(req), { toUserId: input.toUserId, version: input.version, reason: input.reason });
    }),
  };
};

export const adminOrganizationMembersController = createAdminOrganizationMembersController();
