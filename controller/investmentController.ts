import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { investmentEnabled, InvestmentError } from "../src/modules/investment/domain";
import { investmentRepository } from "../src/modules/investment/postgresInvestmentRepository";
import { investmentExportEnabled, renderInvestmentExport } from "../src/modules/investment/exportDocument";
import { exportFilename } from "../src/modules/shared/exportHtml";

const context = (req: AuthRequest) => {
  if (!investmentEnabled()) throw new InvestmentError("INVESTMENT_GUIDANCE_DISABLED", "Investment guidance is disabled.", 503);
  if (!req.user?.organizationId || !req.user.userId) throw new InvestmentError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};
const proposalId = (value: string) => {
  if (!/^[0-9a-f]{24}$/i.test(value)) throw new InvestmentError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return value;
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof InvestmentError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  res.status(status).type("application/problem+json").json({
    type: `https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title: known ? error.message : "Investment guidance operation failed",
    status,
    code,
  });
};

export const generateInvestmentGuidance = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.status(201).json({ data: await investmentRepository.generate({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) }) });
  } catch (error) { handle(res, error); }
};

export const latestInvestmentGuidance = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({ data: await investmentRepository.latest({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) }) });
  } catch (error) { handle(res, error); }
};

/**
 * The estimate is what a planner takes to whoever approves the money, and that
 * person does not have a login. Retyping the ranges into a spreadsheet dropped
 * the refusals and assumptions — the parts that stop a range reading as a quote.
 *
 * Per-line provenance is deliberately absent from the rendered document: it is
 * the shape of the proprietary pricing workbook, and this file leaves the
 * building.
 */
export const exportInvestmentGuidance = async (req: AuthRequest, res: Response) => {
  try {
    if (!investmentExportEnabled())
      throw new InvestmentError(
        "INVESTMENT_EXPORT_DISABLED",
        "Investment estimate export is not enabled in this environment.",
        503,
      );
    const ctx = context(req);
    const report = await investmentRepository.latest({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) });
    if (!report)
      throw new InvestmentError("INVESTMENT_REPORT_NOT_FOUND", "Generate an estimate before exporting it.", 404);

    const generatedAt = new Date();
    const html = renderInvestmentExport({
      currency: report.currency,
      totalLowMinor: report.totalLowMinor,
      totalMidMinor: report.totalMidMinor,
      totalHighMinor: report.totalHighMinor,
      lineItems: report.lineItems ?? [],
      refusals: report.refusals ?? [],
      ancillary: report.ancillary ?? [],
      assumptions: report.assumptions ?? [],
      scenarios: report.scenarios ?? [],
      confidence: String(report.confidence ?? "unknown"),
      generatedAt,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename("investment", "estimate", generatedAt)}"`,
    );
    res.send(html);
  } catch (error) { handle(res, error); }
};
