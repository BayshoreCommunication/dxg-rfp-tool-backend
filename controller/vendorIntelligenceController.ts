import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { durableJobDispatcher } from "../src/modules/durableJobs/composition";
import { VendorIntelligenceError } from "../src/modules/vendorIntelligence/domain";
import { vendorIntelligenceRepository } from "../src/modules/vendorIntelligence/postgresVendorIntelligenceRepository";

const mongoId = (value: unknown, code: string, message: string) => {
  const normalized = String(value ?? "");
  if (!/^[0-9a-f]{24}$/i.test(normalized)) throw new VendorIntelligenceError(code, message, 404);
  return normalized;
};
const uuid = (value: unknown, code: string, message: string) => {
  const normalized = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized))
    throw new VendorIntelligenceError(code, message, 404);
  return normalized;
};
const idempotencyKey = (req: AuthRequest) => {
  const value = String(req.headers["idempotency-key"] ?? "").trim();
  if (!value || value.length > 200)
    throw new VendorIntelligenceError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 400);
  return value;
};
const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId)
    throw new VendorIntelligenceError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    proposalMongoId: mongoId(req.params.proposalId, "PROPOSAL_NOT_FOUND", "Proposal was not found."),
    submissionMongoId: mongoId(req.params.submissionId, "VENDOR_SUBMISSION_NOT_FOUND", "Vendor submission was not found."),
    versionMongoId: mongoId(req.params.versionId, "SUBMISSION_VERSION_NOT_FOUND", "Vendor submission version was not found."),
  };
};
const correlationId = (req: AuthRequest) => String(req.headers["x-correlation-id"] || crypto.randomUUID());
const handle = (res: Response, error: unknown) => {
  const known = error instanceof VendorIntelligenceError;
  const status = known ? error.status : 500;
  res.status(status).json({
    title: known ? error.message : "Vendor intelligence operation failed.",
    status,
    code: known ? error.code : "INTERNAL_ERROR",
  });
};

export const createVendorIntelligence = async (req: AuthRequest, res: Response) => {
  try {
    const requirementSetValue = (req.body as Record<string, unknown> | undefined)?.requirementSetId;
    const result = await vendorIntelligenceRepository.create({
      ...context(req),
      requirementSetId: requirementSetValue == null || requirementSetValue === ""
        ? null : uuid(requirementSetValue, "REQUIREMENT_SET_NOT_FOUND", "Requirement set was not found."),
      idempotencyKey: idempotencyKey(req),
      correlationId: correlationId(req),
    });
    void durableJobDispatcher.dispatch().catch(() => undefined);
    res.status(result.created ? 202 : 200).json({
      data: {
        ...result.run,
        statusUrl: `/api/v1/jobs/${result.run.jobId}`,
        resultUrl: `${req.baseUrl}${req.path.replace(/\/fact-mapping-jobs$/, "/fact-mapping-runs/latest")}`,
      },
    });
  } catch (error) { handle(res, error); }
};

export const readLatestVendorIntelligence = async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await vendorIntelligenceRepository.read(context(req)) }); }
  catch (error) { handle(res, error); }
};

export const readVendorIntelligence = async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await vendorIntelligenceRepository.read({
      ...context(req), runId: uuid(req.params.runId, "INTELLIGENCE_RUN_NOT_FOUND", "Vendor intelligence run was not found."),
    }) });
  } catch (error) { handle(res, error); }
};

export const reviewVendorIntelligence = async (req: AuthRequest, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const targetType = body.targetType === "fact" || body.targetType === "mapping" ? body.targetType : null;
    const decisions = ["accepted", "rejected", "corrected", "escalated"] as const;
    const decision = decisions.find((item) => item === body.decision);
    if (!targetType || !decision)
      throw new VendorIntelligenceError("REVIEW_INVALID", "Review target or decision is invalid.", 422);
    const correctedPayload = body.correctedPayload === null || body.correctedPayload === undefined
      ? null
      : typeof body.correctedPayload === "object" && !Array.isArray(body.correctedPayload)
        ? body.correctedPayload as Record<string, unknown>
        : (() => { throw new VendorIntelligenceError("REVIEW_INVALID", "Corrected value is invalid.", 422); })();
    const result = await vendorIntelligenceRepository.review({
      ...context(req),
      runId: uuid(req.params.runId, "INTELLIGENCE_RUN_NOT_FOUND", "Vendor intelligence run was not found."),
      targetType,
      targetId: uuid(body.targetId, "REVIEW_TARGET_NOT_FOUND", "Review target was not found."),
      decision,
      reasonCode: String(body.reasonCode ?? "reviewed"),
      note: String(body.note ?? ""),
      correctedPayload,
      idempotencyKey: idempotencyKey(req),
      correlationId: correlationId(req),
    });
    res.status(201).json({ data: { reviewId: result.id, createdAt: result.created_at } });
  } catch (error) { handle(res, error); }
};
