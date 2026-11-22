import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import type { PlanStaff } from "../src/modules/entitlements/application/manageOrganizationPlans";
import type { StaffOrganizationBlock } from "../src/modules/staffAccess/application/manageOrganizationBlock";
import { staffOrganizationBlock as defaultBlock } from "../src/modules/staffAccess/composition";
import { StaffAccessError, StaffMemberError } from "../src/modules/staffAccess/domain";

// Staff organization block (owner decision, 2026-11-18; docs/DECISIONS.md). Two writes: block and
// reactivate. Nothing here touches a member, a proposal, a template or the vendor list.

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
  console.error("Staff organization block error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "STAFF_ORGANIZATION_BLOCK_INTERNAL_ERROR", message: "The organization could not be changed." });
};

export const createAdminOrganizationBlockController = (service: StaffOrganizationBlock = defaultBlock) => {
  const handle = (run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(200).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  // The organization always comes from the path, never from the session or the body.
  const organization = (req: AuthRequest) => String(req.params.organizationId ?? "");
  return {
    block: handle((req) => service.block(staffFrom(req), organization(req), { reason: body(req).reason })),
    reactivate: handle((req) => service.reactivate(staffFrom(req), organization(req), { reason: body(req).reason })),
  };
};

export const adminOrganizationBlockController = createAdminOrganizationBlockController();
