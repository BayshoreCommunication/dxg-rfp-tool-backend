import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  EXPERT_RULE_STATUSES,
  parseExpertRuleInput,
  parsePricingRecordInput,
  parseStatusChange,
  PRICING_CATEGORIES,
  PRICING_RECORD_STATUSES,
  PricingError,
  pricingEnabled,
} from "../src/modules/pricing/domain";
import { pricingRepository } from "../src/modules/pricing/postgresPricingRepository";

const context = (req: AuthRequest) => {
  if (!pricingEnabled()) throw new PricingError("PRICING_DISABLED", "The pricing corpus is disabled.", 503);
  if (!req.user?.organizationId || !req.user.userId) throw new PricingError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new PricingError("RESOURCE_NOT_FOUND", "Pricing resource was not found.", 404);
  return value;
};
const expectedRevision = (body: unknown) => {
  const revision = Number((body as { expectedRevision?: unknown } | null | undefined)?.expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new PricingError("EXPECTED_REVISION_REQUIRED", "expectedRevision must be a positive integer.", 422);
  return revision;
};
const filterIn = (value: unknown, allowed: readonly string[], label: string) => {
  if (value === undefined || value === "") return undefined;
  const filter = String(value);
  if (!allowed.includes(filter)) throw new PricingError("INVALID_FILTER", `${label} filter must be one of: ${allowed.join(", ")}.`);
  return filter;
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof PricingError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  res.status(status).type("application/problem+json").json({
    type: `https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title: known ? error.message : "Pricing operation failed",
    status,
    code,
  });
};

export const listPricingRecords = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({
      data: await pricingRepository.listRecords(ctx, {
        status: filterIn(req.query.status, PRICING_RECORD_STATUSES, "status"),
        category: filterIn(req.query.category, PRICING_CATEGORIES, "category"),
        limit: Number(req.query.limit) || undefined,
      }),
    });
  } catch (error) { handle(res, error); }
};

export const createPricingRecord = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.status(201).json({ data: await pricingRepository.createRecord(ctx, parsePricingRecordInput(req.body)) });
  } catch (error) { handle(res, error); }
};

export const updatePricingRecord = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({
      data: await pricingRepository.updateRecord(
        ctx, uuid(req.params.recordId), parsePricingRecordInput(req.body), expectedRevision(req.body),
      ),
    });
  } catch (error) { handle(res, error); }
};

export const changePricingRecordStatus = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({
      data: await pricingRepository.setRecordStatus(ctx, uuid(req.params.recordId), parseStatusChange(req.body, ["approved", "retired"])),
    });
  } catch (error) { handle(res, error); }
};

export const listExpertRules = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({
      data: await pricingRepository.listRules(ctx, {
        status: filterIn(req.query.status, EXPERT_RULE_STATUSES, "status"),
        limit: Number(req.query.limit) || undefined,
      }),
    });
  } catch (error) { handle(res, error); }
};

export const createExpertRule = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.status(201).json({ data: await pricingRepository.createRule(ctx, parseExpertRuleInput(req.body)) });
  } catch (error) { handle(res, error); }
};

export const updateExpertRule = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({
      data: await pricingRepository.updateRule(
        ctx, uuid(req.params.ruleId), parseExpertRuleInput(req.body), expectedRevision(req.body),
      ),
    });
  } catch (error) { handle(res, error); }
};

export const changeExpertRuleStatus = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({
      data: await pricingRepository.setRuleStatus(ctx, uuid(req.params.ruleId), parseStatusChange(req.body, ["active", "retired"])),
    });
  } catch (error) { handle(res, error); }
};
