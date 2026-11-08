import type { Request, Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { correlationId } from "./authController";
import { accessRequests } from "../src/modules/accessRequests/composition";
import { ACCESS_REQUEST_STATUSES, type AccessRequestService, type DecisionOutcome } from "../src/modules/accessRequests/accessRequests";
import { mongoOtpRepository } from "../src/modules/auth/infrastructure/mongo/mongoOtpRepository";
import type { InvitingActor } from "../src/modules/invitations/domain/invitationRules";

/* ORG-306. POST /api/auth/access-requests is public: the email must have passed the signup code
   check, which also proves the person controls an address on the matched domain. The rest is
   for Owners and Admins (organization:manage), always in the caller's own organization. */

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

const handleError = (res: Response, context: string) => (error: unknown) => {
  console.error(`Access request ${context} error:`, error instanceof Error ? error.name : "unknown");
  fail(res, 500, "ACCESS_REQUEST_ERROR", "Request failed");
};

const actorOf = (req: AuthRequest): InvitingActor => {
  const actor = req.rfpActor!;
  return { organizationId: String(actor.organizationId), userId: String(actor.userId), roles: actor.roles, managedTeamIds: actor.managedTeamIds.map(String) };
};

const respondToDecision = (res: Response, outcome: DecisionOutcome) => {
  if (outcome.kind === "not_found") return fail(res, 404, "ACCESS_REQUEST_NOT_FOUND", "Access request not found");
  if (outcome.kind === "not_pending") {
    return fail(res, 409, "ACCESS_REQUEST_NOT_PENDING", "This request has already been decided", { status: outcome.status });
  }
  if (outcome.kind === "invitation_refused") return fail(res, outcome.status, outcome.code, outcome.message);
  return res.status(200).json({ success: true, data: outcome.request });
};

export const createAccessRequestController = (
  service: AccessRequestService = accessRequests,
  otps: Pick<typeof mongoOtpRepository, "hasVerified" | "consumeVerified"> = mongoOtpRepository,
) => ({
  /* POST /api/auth/access-requests { email, name } */
  request: async (req: Request, res: Response) => {
    try {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!email) return fail(res, 400, "INVALID_EMAIL", "Email is required");
      if (!(await otps.hasVerified(email, "signup"))) {
        return fail(res, 403, "EMAIL_NOT_VERIFIED", "Verify your email with the code we sent before requesting access.");
      }
      const outcome = await service.request({ email, name: req.body?.name, correlationId: correlationId(req) });
      if (outcome.kind === "validation") return fail(res, 400, outcome.code, outcome.message);
      if (outcome.kind === "no_match") return fail(res, 409, "NO_ORGANIZATION_MATCH", "No organization on RFPilot uses your email domain.");
      if (outcome.kind === "account_exists") return fail(res, 409, "ACCOUNT_EXISTS", "An account with this email already exists. Please sign in.");
      await otps.consumeVerified(email, "signup");
      return res.status(201).json({ success: true, status: outcome.kind, organizationName: outcome.organizationName });
    } catch (error) {
      return handleError(res, "create")(error);
    }
  },

  /* GET /api/v1/organization/access-requests?status=pending|approved|denied|all */
  list: async (req: AuthRequest, res: Response) => {
    try {
      const raw = typeof req.query.status === "string" ? req.query.status : "pending";
      const status = raw === "all" || (ACCESS_REQUEST_STATUSES as readonly string[]).includes(raw) ? raw : "pending";
      const data = await service.list(actorOf(req).organizationId, status as never);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return handleError(res, "list")(error);
    }
  },

  /* POST /api/v1/organization/access-requests/:id/approve { role?, teamId? } */
  approve: async (req: AuthRequest, res: Response) => {
    try {
      const outcome = await service.approve(actorOf(req), String(req.params.id ?? ""), req.body ?? {}, correlationId(req));
      return respondToDecision(res, outcome);
    } catch (error) {
      return handleError(res, "approve")(error);
    }
  },

  /* POST /api/v1/organization/access-requests/:id/deny */
  deny: async (req: AuthRequest, res: Response) => {
    try {
      return respondToDecision(res, await service.deny(actorOf(req), String(req.params.id ?? ""), correlationId(req)));
    } catch (error) {
      return handleError(res, "deny")(error);
    }
  },

  /* GET /api/v1/organization/access-requests/settings */
  settings: async (req: AuthRequest, res: Response) => {
    try {
      return res.status(200).json({ success: true, data: await service.settings(actorOf(req).organizationId) });
    } catch (error) {
      return handleError(res, "settings")(error);
    }
  },

  /* PUT /api/v1/organization/access-requests/settings { autoApproveDomain } */
  updateSettings: async (req: AuthRequest, res: Response) => {
    try {
      const outcome = await service.setAutoApprove(actorOf(req), req.body?.autoApproveDomain, correlationId(req));
      if (outcome.kind === "validation") return fail(res, 400, "VALIDATION_ERROR", "autoApproveDomain must be true or false");
      if (outcome.kind === "no_verified_domain") {
        return fail(res, 409, "NO_VERIFIED_DOMAIN", "Verify a domain in Security before turning on auto-approve.");
      }
      return res.status(200).json({ success: true, data: outcome.settings });
    } catch (error) {
      return handleError(res, "settings")(error);
    }
  },
});
