import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import type { PlanStaff } from "../src/modules/entitlements/application/manageOrganizationPlans";
import type { StaffTeamManagement } from "../src/modules/staffAccess/application/manageOrganizationTeams";
import { staffTeamManagement as defaultManagement } from "../src/modules/staffAccess/composition";
import { StaffAccessError, StaffMemberError } from "../src/modules/staffAccess/domain";

// Staff team management (owner decision, 2026-11-18; docs/DECISIONS.md). Teams and a member's
// teams only: there is no handler here that touches a proposal (not even the team it is on), a
// template or the vendor list.

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
  console.error("Staff team management error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "STAFF_TEAMS_INTERNAL_ERROR", message: "The team change could not be completed." });
};

export const createAdminOrganizationTeamsController = (management: StaffTeamManagement = defaultManagement) => {
  // 201 where the customer's own route answers 201 (a team created, a member added).
  const handle = (status: number, run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(status).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  // The organization, the team and the member always come from the path, never from the session,
  // the query or the body (the member a team gains is the one thing a body names).
  const organization = (req: AuthRequest) => String(req.params.organizationId ?? "");
  const team = (req: AuthRequest) => String(req.params.teamId ?? "");
  const member = (req: AuthRequest) => String(req.params.userId ?? "");
  return {
    team: handle(200, (req) => management.team(staffFrom(req), organization(req), team(req))),
    create: handle(201, (req) => {
      const input = body(req);
      return management.create(staffFrom(req), organization(req), { name: input.name, reason: input.reason });
    }),
    rename: handle(200, (req) => {
      const input = body(req);
      return management.rename(staffFrom(req), organization(req), team(req), { name: input.name, reason: input.reason });
    }),
    archive: handle(200, (req) => management.archive(staffFrom(req), organization(req), team(req), { reason: body(req).reason })),
    addMember: handle(201, (req) => {
      const input = body(req);
      return management.addMember(staffFrom(req), organization(req), team(req), { userId: input.userId, isManager: input.isManager, reason: input.reason });
    }),
    setManager: handle(200, (req) => {
      const input = body(req);
      return management.setManager(staffFrom(req), organization(req), team(req), member(req), { isManager: input.isManager, reason: input.reason });
    }),
    // The reason of a removal is in the request body, like every other write: never in the URL.
    removeMember: handle(200, (req) => management.removeMember(staffFrom(req), organization(req), team(req), member(req), { reason: body(req).reason })),
    setMemberTeams: handle(200, (req) => {
      const input = body(req);
      return management.setMemberTeams(staffFrom(req), organization(req), member(req), { teamIds: input.teamIds, version: input.version, reason: input.reason });
    }),
  };
};

export const adminOrganizationTeamsController = createAdminOrganizationTeamsController();
