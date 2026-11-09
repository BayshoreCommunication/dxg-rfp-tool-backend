import type { Response } from "express";
import mongoose from "mongoose";
import type { AuthRequest } from "../middleware/auth";
import { checkRequestProposalAccess, respondIfProposalAccessDenied } from "../src/modules/identity/application/proposalAccess";
import type { RfpAction } from "../src/modules/identity/domain/rfpAccessPolicy";
import { proposalLifecycle } from "../src/modules/proposalLifecycle/composition";
import { safeLog } from "../src/shared/observability/safeTelemetry";

type Scope = { organizationId: string; userId: string; proposalId: string };

// Resolves the caller and checks the access policy for this proposal. Answers the request and
// returns null when the caller may not act on it.
const authorize = async (req: AuthRequest, res: Response, action: RfpAction): Promise<Scope | null> => {
  const organizationId = req.user?.organizationId;
  const userId = req.user?.userId;
  const proposalId = String(req.params.id ?? "");
  if (!organizationId || !userId) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return null;
  }
  if (!mongoose.isValidObjectId(proposalId) || (await checkRequestProposalAccess(userId, proposalId, action)) === "not_found") {
    res.status(404).json({ success: false, message: "Proposal not found" });
    return null;
  }
  return { organizationId, userId, proposalId };
};

const fail = (res: Response, error: unknown, operation: string) => {
  if (respondIfProposalAccessDenied(res, error)) return;
  safeLog("error", "proposal_lifecycle_request_failed", {
    operation,
    errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
    outcome: "failure",
  });
  res.status(500).json({ success: false, message: "The proposal's status could not be updated" });
};

const view = (lifecycle: { stage?: unknown; awardedAt?: unknown; awardSource?: unknown; awardedByUserId?: unknown; changedAt?: unknown }) => ({
  stage: lifecycle.stage ?? null,
  awardedAt: lifecycle.awardedAt ?? null,
  awardSource: lifecycle.awardSource ?? null,
  awardedByUserId: lifecycle.awardedByUserId ?? null,
  changedAt: lifecycle.changedAt ?? null,
});

// POST /api/proposals/:id/award: the planner's "Mark as awarded" (ORG-403).
export const markProposalAwarded = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = await authorize(req, res, "edit");
    if (!scope) return;
    const result = await proposalLifecycle.markAwarded(scope);
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }
    if (result.kind === "not_awardable") {
      res.status(409).json({ success: false, code: "PROPOSAL_NOT_AWARDABLE", message: "Only a sent, unarchived RFP can be marked as awarded" });
      return;
    }
    res.json({ success: true, data: view(result.lifecycle) });
  } catch (error) {
    fail(res, error, "awarded");
  }
};

// DELETE /api/proposals/:id/award: withdraws an award, whether a planner or a comparison set it.
export const clearProposalAward = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = await authorize(req, res, "edit");
    if (!scope) return;
    const result = await proposalLifecycle.clearAward(scope);
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }
    res.json({ success: true, data: view(result.lifecycle) });
  } catch (error) {
    fail(res, error, "award_cleared");
  }
};

// GET /api/proposals/:id/status-history: the append-only stage history (PRD P0-10).
export const getProposalStatusHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = await authorize(req, res, "view");
    if (!scope) return;
    const history = await proposalLifecycle.history(scope);
    if (!history) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }
    res.json({ success: true, data: { ...view({ ...history.lifecycle, stage: history.stage }), transitions: history.transitions } });
  } catch (error) {
    fail(res, error, "status_history");
  }
};
