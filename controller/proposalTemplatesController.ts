import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { ProposalTemplateError, type TemplateActor } from "../src/modules/proposalTemplates/domain";
import type { ProposalTemplates } from "../src/modules/proposalTemplates/application/manageProposalTemplates";
import { proposalTemplates } from "../src/modules/proposalTemplates/composition";
import { respondIfProposalAccessDenied } from "../src/modules/identity/application/proposalAccess";
import { respondIfPlanError } from "../src/modules/entitlements/http/planGate";

// The actor is always the signed-in member's own organization; no id in the path or body can widen it.
const actorFrom = (req: AuthRequest): TemplateActor => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) throw new ProposalTemplateError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    userId: user.userId,
    organizationId: user.organizationId,
    roles: user.roles ?? [],
    correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
  };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

const validationMessages = (error: unknown): string[] | null => {
  const candidate = error as { name?: string; errors?: Record<string, { message?: string }> } | null;
  if (candidate?.name !== "ValidationError" || !candidate.errors) return null;
  return Object.values(candidate.errors).map((entry) => entry.message ?? "Invalid value");
};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof ProposalTemplateError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  // The source RFP is in the organization but the member can't see it (403).
  if (respondIfProposalAccessDenied(res, error)) return;
  // An RFP started from a template needs a plan slot like any other (ORG-601).
  if (respondIfPlanError(res, error)) return;
  const messages = validationMessages(error);
  if (messages) {
    res.status(400).json({ success: false, code: "TEMPLATE_VALIDATION_FAILED", message: "Validation failed", errors: messages });
    return;
  }
  console.error("RFP template error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "TEMPLATE_INTERNAL_ERROR", message: "The template request could not be completed." });
};

export const createProposalTemplatesController = (templates: ProposalTemplates = proposalTemplates) => {
  const handle = (status: number, run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(status).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  return {
    list: handle(200, (req) => templates.list(actorFrom(req), req.query as Record<string, unknown>)),
    get: handle(200, (req) => templates.get(actorFrom(req), req.params.templateId)),
    create: handle(201, (req) => templates.saveFromProposal(actorFrom(req), body(req))),
    update: handle(200, (req) => templates.update(actorFrom(req), req.params.templateId, body(req))),
    publish: handle(200, (req) => templates.publish(actorFrom(req), req.params.templateId)),
    unpublish: handle(200, (req) => templates.unpublish(actorFrom(req), req.params.templateId)),
    archive: handle(200, (req) => templates.archive(actorFrom(req), req.params.templateId)),
    restore: handle(200, (req) => templates.restore(actorFrom(req), req.params.templateId)),
    createProposal: handle(201, (req) => templates.createProposal(actorFrom(req), req.params.templateId, body(req))),
  };
};

export const proposalTemplatesController = createProposalTemplatesController();
