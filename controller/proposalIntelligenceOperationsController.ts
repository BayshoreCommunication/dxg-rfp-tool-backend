import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { comparisonOrchestrationRepository } from "../src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository";
import { ComparisonOrchestrationError } from "../src/modules/comparisonOrchestration/domain";
import { proposalIntelligenceOperationsRepository } from "../src/modules/proposalIntelligenceOperations/postgresProposalIntelligenceOperationsRepository";
import { buildProposalIntelligenceReport, REPORT_TYPES, type ReportType } from "../src/modules/proposalIntelligenceOperations/reportBuilder";

const mongoId = (value: unknown, code: string) => { const id = String(value ?? ""); if (!/^[0-9a-f]{24}$/i.test(id)) throw new ComparisonOrchestrationError(code, "Proposal intelligence input was not found.", 404); return id; };
const uuid = (value: unknown, code = "COMPARISON_NOT_FOUND") => { const id = String(value ?? ""); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ComparisonOrchestrationError(code, "Proposal intelligence resource was not found.", 404); return id; };
const idempotencyKey = (req: AuthRequest) => { const key = String(req.headers["idempotency-key"] ?? "").trim(); if (!key || key.length > 200) throw new ComparisonOrchestrationError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 400); return key; };
const expectedVersion = (req: AuthRequest) => { const raw = String(req.headers["if-match"] ?? "").replace(/^W\//, "").replace(/"/g, ""); const value = Number(raw); if (!Number.isInteger(value) || value < 0) throw new ComparisonOrchestrationError("EXPECTED_VERSION_REQUIRED", "If-Match with the current version is required.", 400); return value; };
const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId) throw new ComparisonOrchestrationError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { organizationMongoId: req.user.organizationId, actorUserMongoId: req.user.userId, proposalMongoId: mongoId(req.params.proposalId, "PROPOSAL_NOT_FOUND"), correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()) };
};
const handle = (res: Response, error: unknown) => { const known = error instanceof ComparisonOrchestrationError; const status = known ? error.status : 500; res.status(status).json({ title: known ? error.message : "Proposal intelligence operation failed.", status, code: known ? error.code : "INTERNAL_ERROR" }); };

export const listClarificationSets = async (req: AuthRequest, res: Response) => { try { res.json({ data: await proposalIntelligenceOperationsRepository.listClarifications({ ...context(req), runId: uuid(req.params.runId) }) }); } catch (error) { handle(res, error); } };
export const createClarificationSet = async (req: AuthRequest, res: Response) => { try { const value = await proposalIntelligenceOperationsRepository.createClarification({ ...context(req), runId: uuid(req.params.runId), idempotencyKey: idempotencyKey(req) }); res.status(value.created ? 201 : 200).json({ data: value }); } catch (error) { handle(res, error); } };
export const updateClarificationQuestion = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>, disposition = ["included", "excluded"].find((value) => value === body.disposition) as "included" | "excluded" | undefined;
  if (!disposition || typeof body.question !== "string" || Object.keys(body).some((key) => !["question", "disposition"].includes(key))) throw new ComparisonOrchestrationError("CLARIFICATION_QUESTION_INVALID", "Question and disposition are required.");
  res.json({ data: await proposalIntelligenceOperationsRepository.updateClarificationQuestion({ ...context(req), runId: uuid(req.params.runId), setId: uuid(req.params.setId, "CLARIFICATION_SET_NOT_FOUND"), questionId: uuid(req.params.questionId, "CLARIFICATION_QUESTION_NOT_FOUND"), question: body.question, disposition, expectedVersion: expectedVersion(req), idempotencyKey: idempotencyKey(req) }) });
} catch (error) { handle(res, error); } };
export const approveClarificationSet = async (req: AuthRequest, res: Response) => { try { res.json({ data: await proposalIntelligenceOperationsRepository.approveClarification({ ...context(req), runId: uuid(req.params.runId), setId: uuid(req.params.setId, "CLARIFICATION_SET_NOT_FOUND"), expectedVersion: expectedVersion(req), idempotencyKey: idempotencyKey(req) }) }); } catch (error) { handle(res, error); } };
export const recordClarificationDispatch = async (req: AuthRequest, res: Response) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>, channel = ["email_campaign", "manual"].find((value) => value === body.channel) as "email_campaign" | "manual" | undefined;
  if (!channel || typeof body.externalReference !== "string" || !Number.isInteger(body.recipientCount) || Object.keys(body).some((key) => !["channel", "externalReference", "recipientCount"].includes(key))) throw new ComparisonOrchestrationError("CLARIFICATION_DISPATCH_INVALID", "Dispatch channel, reference, and recipient count are required.");
  res.json({ data: await proposalIntelligenceOperationsRepository.recordClarificationDispatch({ ...context(req), runId: uuid(req.params.runId), setId: uuid(req.params.setId, "CLARIFICATION_SET_NOT_FOUND"), channel, externalReference: body.externalReference, recipientCount: Number(body.recipientCount), idempotencyKey: idempotencyKey(req) }) });
} catch (error) { handle(res, error); } };

export const readComparisonAudit = async (req: AuthRequest, res: Response) => { try { res.json({ data: await proposalIntelligenceOperationsRepository.readAudit({ ...context(req), runId: uuid(req.params.runId) }) }); } catch (error) { handle(res, error); } };
export const readComparisonOperations = async (req: AuthRequest, res: Response) => { try { res.json({ data: await proposalIntelligenceOperationsRepository.readOperations({ ...context(req), runId: uuid(req.params.runId) }) }); } catch (error) { handle(res, error); } };
export const updateIntelligenceRetentionPolicy = async (req: AuthRequest, res: Response) => { try { const body = (req.body ?? {}) as Record<string, unknown>; if (!Number.isInteger(body.retentionDays) || typeof body.policyBasis !== "string") throw new ComparisonOrchestrationError("RETENTION_POLICY_INVALID", "Retention days and policy basis are required."); res.json({ data: await proposalIntelligenceOperationsRepository.updateRetentionPolicy({ ...context(req), runId: uuid(req.params.runId), retentionDays: Number(body.retentionDays), policyBasis: body.policyBasis, expectedVersion: expectedVersion(req) }) }); } catch (error) { handle(res, error); } };
export const placeIntelligenceLegalHold = async (req: AuthRequest, res: Response) => { try { res.status(201).json({ data: await proposalIntelligenceOperationsRepository.placeLegalHold({ ...context(req), runId: uuid(req.params.runId), reason: String(req.body?.reason ?? ""), idempotencyKey: idempotencyKey(req) }) }); } catch (error) { handle(res, error); } };
export const releaseIntelligenceLegalHold = async (req: AuthRequest, res: Response) => { try { res.json({ data: await proposalIntelligenceOperationsRepository.releaseLegalHold({ ...context(req), runId: uuid(req.params.runId), holdId: uuid(req.params.holdId, "LEGAL_HOLD_NOT_FOUND"), reason: String(req.body?.reason ?? ""), idempotencyKey: idempotencyKey(req) }) }); } catch (error) { handle(res, error); } };

export const exportProposalIntelligenceReport = async (req: AuthRequest, res: Response) => { try {
  const reportType = REPORT_TYPES.find((value) => value === req.params.reportType) as ReportType | undefined;
  if (!reportType) throw new ComparisonOrchestrationError("REPORT_TYPE_INVALID", "Report type is not supported.", 404);
  const ctx = context(req), runId = uuid(req.params.runId);
  const [workspace, clarifications, audit] = await Promise.all([
    comparisonOrchestrationRepository.read({ ...ctx, runId }),
    proposalIntelligenceOperationsRepository.listClarifications({ ...ctx, runId }),
    proposalIntelligenceOperationsRepository.readAudit({ ...ctx, runId }),
  ]);
  if (!["succeeded", "succeeded_with_warnings"].includes(workspace.run.status)) throw new ComparisonOrchestrationError("REPORT_NOT_READY", "Complete the comparison before exporting reports.", 409);
  if (!workspace.intelligence) throw new ComparisonOrchestrationError("REPORT_NOT_READY", "Persisted comparison intelligence is unavailable.", 409);
  const report = await buildProposalIntelligenceReport({ reportType, proposalTitle: workspace.proposal.title, workspace, clarifications, audit });
  await proposalIntelligenceOperationsRepository.recordReportExport({ ...ctx, runId, reportType, mediaType: report.mediaType, manifestChecksum: workspace.manifest.checksum, contentChecksum: report.contentChecksum, freshnessState: workspace.freshness.state, viewCommercial: workspace.intelligence.permissions.viewCommercial, byteSize: report.body.length });
  res.setHeader("Content-Type", report.mediaType); res.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`); res.setHeader("Content-Length", String(report.body.length)); res.setHeader("ETag", `"${report.contentChecksum}"`); res.setHeader("X-RFPilot-Run-Id", runId); res.setHeader("X-RFPilot-Manifest-Checksum", workspace.manifest.checksum); res.setHeader("X-RFPilot-Freshness", workspace.freshness.state); res.setHeader("X-RFPilot-Report-Schema", String(report.reportManifest.schemaVersion)); res.send(report.body);
} catch (error) { handle(res, error); } };
