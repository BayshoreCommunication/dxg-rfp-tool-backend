import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { SupportAccessError, type GrantManager, type SupportAgent } from "../src/modules/supportAccess/domain";
import type { SupportGrantManagement } from "../src/modules/supportAccess/application/manageSupportGrants";
import type { SupportAccess } from "../src/modules/supportAccess/application/supportAccess";
import { supportAccess as defaultAccess, supportGrantManagement as defaultGrants } from "../src/modules/supportAccess/composition";

const correlationOf = (req: AuthRequest) => (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID();

const managerFrom = (req: AuthRequest): GrantManager => {
  if (!req.rfpActor || !req.user) throw new SupportAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { rfpActor: req.rfpActor, accountType: req.user.accountType, correlationId: correlationOf(req) };
};

// Role and account type come from the stored account (set by authenticate), never the token.
const agentFrom = (req: AuthRequest): SupportAgent => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) throw new SupportAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { adminId: user.userId, organizationId: user.organizationId, role: user.role, accountType: user.accountType, correlationId: correlationOf(req) };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof SupportAccessError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Support access error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "SUPPORT_ACCESS_INTERNAL_ERROR", message: "The support access request could not be completed." });
};

export const createSupportAccessController = (dependencies?: { grants?: SupportGrantManagement; access?: SupportAccess }) => {
  const grants = dependencies?.grants ?? defaultGrants;
  const access = dependencies?.access ?? defaultAccess;
  const handle = (run: (req: AuthRequest) => Promise<unknown>, status = 200) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(status).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  return {
    // Organization Owner/Admin.
    listGrants: handle((req) => grants.list(managerFrom(req), { page: req.query.page })),
    createGrant: handle((req) => {
      const input = body(req);
      return grants.create(managerFrom(req), { proposalId: input.proposalId, expiresInDays: input.expiresInDays, expiresAt: input.expiresAt, reason: input.reason });
    }, 201),
    getGrant: handle((req) => grants.get(managerFrom(req), req.params.grantId)),
    revokeGrant: handle((req) => grants.revoke(managerFrom(req), req.params.grantId)),

    // RFPilot Support (admin app).
    listGranted: handle((req) => access.listGranted(agentFrom(req))),
    listGrantedRfps: handle((req) => access.listRfps(agentFrom(req), req.params.organizationId, { page: req.query.page, search: req.query.search })),
    getGrantedRfp: handle((req) => access.getRfp(agentFrom(req), req.params.organizationId, req.params.proposalId)),
    listGrantedVendorResponses: handle((req) => access.listVendorResponses(agentFrom(req), req.params.organizationId, req.params.proposalId)),
    listTicketRfps: handle((req) => access.listTicketRfps(agentFrom(req), req.params.ticketId, { page: req.query.page, search: req.query.search })),
  };
};

export const supportAccessController = createSupportAccessController();
