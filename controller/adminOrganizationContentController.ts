import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import type { PlanStaff } from "../src/modules/entitlements/application/manageOrganizationPlans";
import type { StaffOrganizationContent } from "../src/modules/staffAccess/application/readOrganizationContent";
import { staffOrganizationContent as defaultContent } from "../src/modules/staffAccess/composition";
import { StaffAccessError } from "../src/modules/staffAccess/domain";

// Staff reads of a customer organization's content, with no grant (owner decision, 2026-11-17).
// Read-only: there is no handler here that changes anything.

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

const fail = (res: Response, error: unknown): void => {
  if (error instanceof StaffAccessError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Staff access error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "STAFF_ACCESS_INTERNAL_ERROR", message: "The request could not be completed." });
};

export const createAdminOrganizationContentController = (content: StaffOrganizationContent = defaultContent) => {
  const handle = (run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(200).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  // The organization always comes from the path, never from the session or the query.
  const organization = (req: AuthRequest) => req.params.organizationId;
  return {
    proposals: handle((req) => content.proposals(staffFrom(req), organization(req), { page: req.query.page, search: req.query.search })),
    proposal: handle((req) => content.proposal(staffFrom(req), organization(req), req.params.proposalId)),
    vendorResponses: handle((req) => content.vendorResponses(staffFrom(req), organization(req), req.params.proposalId)),
    members: handle((req) => content.members(staffFrom(req), organization(req), { page: req.query.page })),
    teams: handle((req) => content.teams(staffFrom(req), organization(req))),
    templates: handle((req) => content.templates(staffFrom(req), organization(req), { page: req.query.page, search: req.query.search, scope: req.query.scope, status: req.query.status })),
    template: handle((req) => content.template(staffFrom(req), organization(req), req.params.templateId)),
    vendors: handle((req) => content.vendors(staffFrom(req), organization(req), { page: req.query.page, search: req.query.search, category: req.query.category, status: req.query.status })),
  };
};

export const adminOrganizationContentController = createAdminOrganizationContentController();
