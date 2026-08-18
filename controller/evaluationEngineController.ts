import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { EvaluationEngineError } from "../src/modules/evaluationEngine/domain";
import { evaluationEngineRepository } from "../src/modules/evaluationEngine/postgresEvaluationEngineRepository";

const mongoId = (value: unknown, code: string, message: string) => { const id = String(value ?? ""); if (!/^[0-9a-f]{24}$/i.test(id)) throw new EvaluationEngineError(code, message, 404); return id; };
const uuid = (value: unknown, code = "EVALUATION_RUN_NOT_FOUND") => { const id = String(value ?? ""); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new EvaluationEngineError(code, "Evaluation resource was not found.", 404); return id; };
const key = (req: AuthRequest) => { const value = String(req.headers["idempotency-key"] ?? "").trim(); if (!value || value.length > 200) throw new EvaluationEngineError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 400); return value; };
const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId) throw new EvaluationEngineError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { organizationMongoId: req.user.organizationId, actorUserMongoId: req.user.userId, proposalMongoId: mongoId(req.params.proposalId, "PROPOSAL_NOT_FOUND", "Proposal was not found."), submissionMongoId: mongoId(req.params.submissionId, "VENDOR_SUBMISSION_NOT_FOUND", "Vendor submission was not found."), versionMongoId: mongoId(req.params.versionId, "SUBMISSION_VERSION_NOT_FOUND", "Vendor submission version was not found."), correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()) };
};
const handle = (res: Response, error: unknown) => { const known = error instanceof EvaluationEngineError; const status = known ? error.status : 500; res.status(status).json({ title: known ? error.message : "Vendor evaluation operation failed.", status, code: known ? error.code : "INTERNAL_ERROR" }); };

export const createEvaluation = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await evaluationEngineRepository.create({ ...context(req), intelligenceRunId: body.intelligenceRunId ? uuid(body.intelligenceRunId, "INTELLIGENCE_RUN_NOT_FOUND") : null, sealedPrice: body.sealedPrice === true, idempotencyKey: key(req) });
  res.status(result.created ? 201 : 200).json({ data: result });
} catch (error) { handle(res, error); } };
export const readLatestEvaluation = async (req: AuthRequest, res: Response) => { try { res.json({ data: await evaluationEngineRepository.read(context(req)) }); } catch (error) { handle(res, error); } };
export const readEvaluation = async (req: AuthRequest, res: Response) => { try { res.json({ data: await evaluationEngineRepository.read({ ...context(req), runId: uuid(req.params.runId) }) }); } catch (error) { handle(res, error); } };
export const createAssignment = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>, roles = ["technical", "commercial", "combined", "observer"] as const, role = roles.find((item) => item === body.role);
  if (!role || !Array.isArray(body.criterionIds) || body.criterionIds.some((id) => typeof id !== "string")) throw new EvaluationEngineError("ASSIGNMENT_INVALID", "Assignment is invalid.");
  const result = await evaluationEngineRepository.assign({ ...context(req), runId: uuid(req.params.runId), evaluatorUserMongoId: mongoId(body.evaluatorUserId, "EVALUATOR_NOT_FOUND", "Evaluator was not found."), role, criterionIds: body.criterionIds.map((id) => uuid(id, "CRITERION_NOT_FOUND")) });
  res.status(result.created ? 201 : 200).json({ data: result });
} catch (error) { handle(res, error); } };
export const declareConflict = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>; if (body.status !== "clear" && body.status !== "conflict") throw new EvaluationEngineError("CONFLICT_DECLARATION_INVALID", "Conflict declaration is invalid.");
  res.json({ data: await evaluationEngineRepository.declareConflict({ ...context(req), runId: uuid(req.params.runId), status: body.status, note: String(body.note ?? ""), expectedVersion: Number(body.expectedVersion) }) });
} catch (error) { handle(res, error); } };
export const recordScore = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>, events = ["draft", "submitted", "superseded"] as const, eventType = events.find((item) => item === body.eventType);
  if (!eventType || !Array.isArray(body.evidenceFragmentIds) || body.evidenceFragmentIds.some((id) => typeof id !== "string")) throw new EvaluationEngineError("SCORE_INVALID", "Score event is invalid.");
  const result = await evaluationEngineRepository.score({ ...context(req), runId: uuid(req.params.runId), criterionId: uuid(body.criterionId, "CRITERION_NOT_FOUND"), eventType, score: Number(body.score), rationale: String(body.rationale ?? ""), evidenceFragmentIds: body.evidenceFragmentIds.map((id) => uuid(id, "EVIDENCE_NOT_FOUND")), idempotencyKey: key(req) });
  res.status(result.created ? 201 : 200).json({ data: result });
} catch (error) { handle(res, error); } };
export const reopenScore = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await evaluationEngineRepository.reopen({ ...context(req), runId: uuid(req.params.runId), assignmentId: uuid(body.assignmentId, "ASSIGNMENT_NOT_FOUND"), criterionId: uuid(body.criterionId, "CRITERION_NOT_FOUND"), reason: String(body.reason ?? ""), idempotencyKey: key(req) });
  res.status(result.created ? 201 : 200).json({ data: result });
} catch (error) { handle(res, error); } };
export const commercialAccess = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>; if (body.decision !== "granted" && body.decision !== "revoked") throw new EvaluationEngineError("COMMERCIAL_ACCESS_INVALID", "Commercial access decision is invalid.");
  const result = await evaluationEngineRepository.commercialAccess({ ...context(req), runId: uuid(req.params.runId), assignmentId: uuid(body.assignmentId, "ASSIGNMENT_NOT_FOUND"), decision: body.decision, reason: String(body.reason ?? ""), idempotencyKey: key(req) });
  res.status(result.created ? 201 : 200).json({ data: result });
} catch (error) { handle(res, error); } };
