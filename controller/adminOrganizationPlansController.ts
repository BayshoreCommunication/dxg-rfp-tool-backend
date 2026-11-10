import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  PlanManagementError,
  type OrganizationPlanManagement,
  type PlanStaff,
} from "../src/modules/entitlements/application/manageOrganizationPlans";
import { organizationPlanManagement as defaultManagement } from "../src/modules/entitlements/composition";

// ORG-603: plan management for RFPilot staff (admin app).

// Role and account type come from the stored account (set by authenticate), never the token.
const staffFrom = (req: AuthRequest): PlanStaff => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) throw new PlanManagementError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    adminId: user.userId,
    organizationId: user.organizationId,
    role: user.role,
    accountType: user.accountType,
    correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
  };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof PlanManagementError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Plan management error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "PLAN_MANAGEMENT_INTERNAL_ERROR", message: "The plan request could not be completed." });
};

export const createAdminOrganizationPlansController = (management: OrganizationPlanManagement = defaultManagement) => {
  const handle = (run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(200).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  return {
    list: handle((req) => management.list(staffFrom(req), { page: req.query.page, search: req.query.search })),
    get: handle((req) => management.get(staffFrom(req), req.params.organizationId)),
    change: handle((req) => {
      const input = body(req);
      return management.change(staffFrom(req), req.params.organizationId, { plan: input.plan, note: input.note });
    }),
  };
};

export const adminOrganizationPlansController = createAdminOrganizationPlansController();
