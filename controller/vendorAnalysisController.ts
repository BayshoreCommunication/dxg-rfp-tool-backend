import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { durableJobDispatcher } from "../src/modules/durableJobs/composition";
import {
  vendorAnalysisEnabled,
  VendorAnalysisError,
} from "../src/modules/vendorAnalysis/domain";
import { vendorAnalysisRepository } from "../src/modules/vendorAnalysis/postgresVendorAnalysisRepository";
import { renderVendorAnalysisExport, vendorAnalysisExportEnabled } from "../src/modules/vendorAnalysis/exportDocument";
import { exportFilename } from "../src/modules/shared/exportHtml";

const context = (req: AuthRequest) => {
    if (!vendorAnalysisEnabled())
      throw new VendorAnalysisError(
        "VENDOR_ANALYSIS_DISABLED",
        "Vendor response analysis is disabled.",
        503,
      );
    if (!req.user?.organizationId || !req.user.userId)
      throw new VendorAnalysisError(
        "AUTHENTICATION_REQUIRED",
        "Authentication required.",
        401,
      );
    return {
      organizationMongoId: req.user.organizationId,
      actorUserMongoId: req.user.userId,
      correlationId: String(
        req.headers["x-correlation-id"] || crypto.randomUUID(),
      ),
    };
  },
  mongoId = (value: unknown, code: string, message: string, status = 404) => {
    const normalized = String(value ?? "");
    if (!/^[0-9a-f]{24}$/i.test(normalized))
      throw new VendorAnalysisError(code, message, status);
    return normalized;
  },
  runId = (value: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(value))
      throw new VendorAnalysisError(
        "ANALYSIS_RUN_NOT_FOUND",
        "Vendor analysis run was not found.",
        404,
      );
    return value;
  },
  key = (req: AuthRequest) => {
    const value = String(req.headers["idempotency-key"] || "").trim();
    if (!value || value.length > 200)
      throw new VendorAnalysisError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required.",
        400,
      );
    return value;
  },
  handle = (res: Response, e: unknown) => {
    const known = e instanceof VendorAnalysisError,
      status = known ? e.status : 500,
      code = known ? e.code : "INTERNAL_ERROR";
    res.status(status).json({
      title: known ? e.message : "Vendor analysis operation failed",
      status,
      code,
    });
  };

export const createVendorAnalysis = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req),
      vendorResponseMongoId = mongoId(
        req.params.responseId,
        "VENDOR_RESPONSE_NOT_FOUND",
        "Vendor response was not found.",
      ),
      proposalMongoId = mongoId(
        (req.body as Record<string, unknown> | undefined)?.proposalId,
        "PROPOSAL_ID_REQUIRED",
        "A valid proposalId is required.",
        400,
      ),
      r = await vendorAnalysisRepository.create({
        ...c,
        proposalMongoId,
        vendorResponseMongoId,
        idempotencyKey: key(req),
      });
    void durableJobDispatcher.dispatch().catch(() => undefined);
    res.status(r.created ? 202 : 200).json({
      data: {
        jobId: r.run.job_id,
        runId: r.run.id,
        status: r.run.job_status,
        created: r.created,
        statusUrl: `/api/v1/jobs/${r.run.job_id}`,
        resultUrl: `/api/v1/vendor-responses/${vendorResponseMongoId}/analysis-runs/${r.run.id}?proposalId=${proposalMongoId}`,
      },
    });
  } catch (e) {
    handle(res, e);
  }
};

export const latestVendorAnalysis = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    res.json({
      data: await vendorAnalysisRepository.read({
        ...c,
        vendorResponseMongoId: mongoId(
          req.params.responseId,
          "VENDOR_RESPONSE_NOT_FOUND",
          "Vendor response was not found.",
        ),
        proposalMongoId: mongoId(
          req.query.proposalId,
          "PROPOSAL_ID_REQUIRED",
          "A valid proposalId is required.",
          400,
        ),
      }),
    });
  } catch (e) {
    handle(res, e);
  }
};

export const readVendorAnalysis = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    res.json({
      data: await vendorAnalysisRepository.read({
        ...c,
        vendorResponseMongoId: mongoId(
          req.params.responseId,
          "VENDOR_RESPONSE_NOT_FOUND",
          "Vendor response was not found.",
        ),
        proposalMongoId: mongoId(
          req.query.proposalId,
          "PROPOSAL_ID_REQUIRED",
          "A valid proposalId is required.",
          400,
        ),
        runId: runId(req.params.runId),
      }),
    });
  } catch (e) {
    handle(res, e);
  }
};

/**
 * The shortlisting decision is made in a meeting, from a circulated document,
 * by people who do not have logins. Without this the verdicts were retyped into
 * a spreadsheet and the cited passages stopped travelling with the claims.
 */
export const exportVendorAnalysis = async (req: AuthRequest, res: Response) => {
  try {
    if (!vendorAnalysisExportEnabled())
      throw new VendorAnalysisError(
        "VENDOR_ANALYSIS_EXPORT_DISABLED",
        "Vendor analysis export is not enabled in this environment.",
        503,
      );
    const c = context(req);
    const analysis = await vendorAnalysisRepository.read({
      ...c,
      vendorResponseMongoId: mongoId(
        req.params.responseId,
        "VENDOR_RESPONSE_NOT_FOUND",
        "Vendor response was not found.",
      ),
      proposalMongoId: mongoId(
        req.query.proposalId,
        "PROPOSAL_ID_REQUIRED",
        "A valid proposalId is required.",
        400,
      ),
    });
    const generatedAt = new Date();
    const html = renderVendorAnalysisExport({
      findings: analysis.findings,
      evidence: analysis.evidence,
      generatedAt,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename("vendor-response", "review", generatedAt)}"`,
    );
    res.send(html);
  } catch (e) {
    handle(res, e);
  }
};
