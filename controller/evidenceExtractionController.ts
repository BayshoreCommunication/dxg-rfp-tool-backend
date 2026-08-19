import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { durableJobDispatcher } from "../src/modules/durableJobs/composition";
import { EvidenceExtractionError } from "../src/modules/evidenceExtraction/domain";
import { evidenceExtractionRepository } from "../src/modules/evidenceExtraction/postgresEvidenceExtractionRepository";

const mongoId = (value: unknown, code: string, message: string): string => {
  const normalized = String(value ?? "");
  if (!/^[0-9a-f]{24}$/i.test(normalized)) throw new EvidenceExtractionError(code, message, 404);
  return normalized;
};

const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId) {
    throw new EvidenceExtractionError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  }
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    proposalMongoId: mongoId(req.params.proposalId, "PROPOSAL_NOT_FOUND", "Proposal was not found."),
    submissionMongoId: mongoId(req.params.submissionId, "VENDOR_SUBMISSION_NOT_FOUND", "Vendor submission was not found."),
    versionMongoId: mongoId(req.params.versionId, "VENDOR_VERSION_NOT_FOUND", "Vendor submission version was not found."),
  };
};

const handle = (res: Response, error: unknown) => {
  const known = error instanceof EvidenceExtractionError;
  const status = known ? error.status : 500;
  res.status(status).json({
    title: known ? error.message : "Evidence extraction operation failed.",
    status,
    code: known ? error.code : "INTERNAL_ERROR",
  });
};

export const createEvidenceExtraction = async (req: AuthRequest, res: Response) => {
  try {
    const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new EvidenceExtractionError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 400);
    }
    const result = await evidenceExtractionRepository.create({
      ...context(req),
      idempotencyKey,
      correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
    });
    void durableJobDispatcher.dispatch().catch(() => undefined);
    const created = result.runs.some((run) => run.status === "queued");
    res.status(created ? 202 : 200).json({
      data: {
        ...result,
        runs: result.runs.map((run) => ({
          ...run,
          statusUrl: run.jobId ? `/api/v1/jobs/${run.jobId}` : null,
        })),
        resultUrl: req.originalUrl.replace(/\/extraction-jobs(?:\?.*)?$/, "/extractions"),
      },
    });
  } catch (error) {
    handle(res, error);
  }
};

export const readEvidenceExtractions = async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await evidenceExtractionRepository.read(context(req)) });
  } catch (error) {
    handle(res, error);
  }
};

