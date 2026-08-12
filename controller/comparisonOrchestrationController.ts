import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { comparisonOrchestrationRepository } from "../src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository";
import { ComparisonOrchestrationError } from "../src/modules/comparisonOrchestration/domain";
import { durableJobDispatcher } from "../src/modules/durableJobs/composition";

const mongoId = (value: unknown, code: string) => { const id = String(value ?? ""); if (!/^[0-9a-f]{24}$/i.test(id)) throw new ComparisonOrchestrationError(code, "Comparison input was not found.", 404); return id; };
const uuid = (value: unknown, code = "COMPARISON_NOT_FOUND") => { const id = String(value ?? ""); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ComparisonOrchestrationError(code, "Comparison resource was not found.", 404); return id; };
const idempotencyKey = (req: AuthRequest) => { const key = String(req.headers["idempotency-key"] ?? "").trim(); if (!key || key.length > 200) throw new ComparisonOrchestrationError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 400); return key; };
const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId) throw new ComparisonOrchestrationError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { organizationMongoId: req.user.organizationId, actorUserMongoId: req.user.userId, proposalMongoId: mongoId(req.params.proposalId, "PROPOSAL_NOT_FOUND"), correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()) };
};
const handle = (res: Response, error: unknown) => { const known = error instanceof ComparisonOrchestrationError; const status = known ? error.status : 500; res.status(status).json({ title: known ? error.message : "Comparison operation failed.", status, code: known ? error.code : "INTERNAL_ERROR" }); };

export const createComparison = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>, raw = Array.isArray(body.participants) ? body.participants : [];
  const priceVisibility = ["reviewers", "committee", "hidden"].find((value) => value === body.priceVisibility) as "reviewers" | "committee" | "hidden" | undefined;
  if (!priceVisibility || raw.some((item) => !item || typeof item !== "object")) throw new ComparisonOrchestrationError("COMPARISON_INPUT_INVALID", "Comparison setup is invalid.");
  const participants = raw.map((item) => { const value = item as Record<string, unknown>; return { submissionMongoId: mongoId(value.submissionId, "SUBMISSION_VERSION_NOT_FOUND"), versionMongoId: mongoId(value.versionId, "SUBMISSION_VERSION_NOT_FOUND") }; });
  const result = await comparisonOrchestrationRepository.create({ ...context(req), requirementSetId: uuid(body.requirementSetId, "REQUIREMENT_SET_NOT_APPROVED"), matrixVersionId: uuid(body.evaluationMatrixVersionId, "EVALUATION_MATRIX_NOT_CONFIRMED"), participants, priceVisibility, idempotencyKey: idempotencyKey(req) });
  void durableJobDispatcher.dispatch().catch(() => undefined);
  res.status(result.created ? 202 : 200).json({ data: { ...result, statusUrl: `/api/v1/proposals/${req.params.proposalId}/intelligence/comparisons/${result.runId}/status`, resultUrl: `/api/v1/proposals/${req.params.proposalId}/intelligence/comparisons/${result.runId}` } });
} catch (error) { handle(res, error); } };

export const listComparisons = async (req: AuthRequest, res: Response) => { try { res.json({ data: await comparisonOrchestrationRepository.list(context(req)) }); } catch (error) { handle(res, error); } };
export const readComparison = async (req: AuthRequest, res: Response) => { try { res.json({ data: await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }) }); } catch (error) { handle(res, error); } };
export const readComparisonStatus = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); res.json({ data: { schemaVersion: value.schemaVersion, run: value.run, freshness: value.freshness, participants: value.participants, jobs: value.jobs } }); } catch (error) { handle(res, error); } };
export const readOverviewProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); res.json({ data: { schemaVersion: value.schemaVersion, runId: value.run.runId, freshness: value.freshness, overview: value.intelligence?.overview ?? null } }); } catch (error) { handle(res, error); } };
export const readRequirementProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); res.json({ data: { schemaVersion: value.schemaVersion, runId: value.run.runId, freshness: value.freshness, rows: value.intelligence?.requirements ?? [] } }); } catch (error) { handle(res, error); } };
export const readTechnicalProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); res.json({ data: { schemaVersion: value.schemaVersion, runId: value.run.runId, freshness: value.freshness, rows: value.intelligence?.technical ?? [] } }); } catch (error) { handle(res, error); } };
export const readVendorProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); const participantId = uuid(req.params.participantId, "COMPARISON_PARTICIPANT_NOT_FOUND"), participant = value.snapshot?.participants?.find((item: { participantId: string }) => item.participantId === participantId); if (!participant) throw new ComparisonOrchestrationError("COMPARISON_PARTICIPANT_NOT_FOUND", "Comparison participant was not found.", 404); res.json({ data: participant }); } catch (error) { handle(res, error); } };
export const readCommercialProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); res.json({ data: { schemaVersion: value.schemaVersion, runId: value.run.runId, freshness: value.freshness, permissions: value.intelligence?.permissions ?? { viewCommercial: false }, participants: value.intelligence?.commercial ?? [] } }); } catch (error) { handle(res, error); } };
export const readRiskProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); res.json({ data: { schemaVersion: value.schemaVersion, runId: value.run.runId, freshness: value.freshness, risks: value.intelligence?.risks ?? [] } }); } catch (error) { handle(res, error); } };
export const readEvaluationProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); res.json({ data: { schemaVersion: value.schemaVersion, runId: value.run.runId, freshness: value.freshness, participants: value.intelligence?.evaluation ?? [] } }); } catch (error) { handle(res, error); } };
export const readQuestionProjection = async (req: AuthRequest, res: Response) => { try { const value = await comparisonOrchestrationRepository.read({ ...context(req), runId: uuid(req.params.runId) }); const risks = value.snapshot?.risks ?? []; res.json({ data: { schemaVersion: value.schemaVersion, runId: value.run.runId, freshness: value.freshness, questions: risks.filter((item: { question?: string | null }) => Boolean(item.question)).map((item: { participant_id: string; vendor_label: string; risk_id: string; question: string }) => ({ participantId: item.participant_id, vendorLabel: item.vendor_label, riskId: item.risk_id, question: item.question })) } }); } catch (error) { handle(res, error); } };

export const recordComparisonDecision = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowedKeys = new Set(["decisionType", "selectedParticipantIds", "rationale", "acknowledgeStale"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new ComparisonOrchestrationError("DECISION_INPUT_INVALID", "Only explicit human decision fields are accepted.");
  const decisionType = ["shortlist", "selection", "no_award"].find((value) => value === body.decisionType) as "shortlist" | "selection" | "no_award" | undefined;
  const selected = Array.isArray(body.selectedParticipantIds) ? body.selectedParticipantIds.map((value) => uuid(value, "DECISION_PARTICIPANTS_INVALID")) : [];
  if (!decisionType || typeof body.rationale !== "string" || typeof body.acknowledgeStale !== "boolean") throw new ComparisonOrchestrationError("DECISION_INPUT_INVALID", "Decision type, rationale, and freshness acknowledgement are required.");
  const result = await comparisonOrchestrationRepository.recordDecision({ ...context(req), runId: uuid(req.params.runId), decisionType, selectedParticipantIds: selected, rationale: body.rationale, acknowledgeStale: body.acknowledgeStale, idempotencyKey: idempotencyKey(req) });
  res.status(result.created ? 201 : 200).json({ data: result });
} catch (error) { handle(res, error); } };

export const cancelComparison = async (req: AuthRequest, res: Response) => { try { res.json({ data: await comparisonOrchestrationRepository.cancel({ ...context(req), runId: uuid(req.params.runId) }) }); } catch (error) { handle(res, error); } };
export const retryComparison = async (req: AuthRequest, res: Response) => { try { const result = await comparisonOrchestrationRepository.retry({ ...context(req), runId: uuid(req.params.runId), idempotencyKey: idempotencyKey(req), reason: String(req.body?.reason ?? "") }); void durableJobDispatcher.dispatch().catch(() => undefined); res.json({ data: result }); } catch (error) { handle(res, error); } };
