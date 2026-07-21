import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { aiGatewayRepository } from "../src/modules/aiGateway/composition";
import {
  AI_OPERATIONS,
  AI_SYNTHETIC_FIXTURES,
  AiGatewayError,
  type AiOperation,
  type AiTestRequest,
} from "../src/modules/aiGateway/domain";
import {
  durableJobDispatcher,
  durableJobRepository,
} from "../src/modules/durableJobs/composition";
import { durableJobsEnabled } from "../src/modules/durableJobs/redis";
import { LIVE_AI_INPUT_TOKEN_LIMIT, LIVE_AI_MODEL, LIVE_AI_OUTPUT_TOKEN_LIMIT } from "../src/modules/liveAi/openAiProvider";
const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId)
    throw new AiGatewayError(
      "AUTHENTICATION_REQUIRED",
      "Authentication required.",
      401,
    );
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
  };
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof AiGatewayError;
  const status = known ? error.status : 500;
  res
    .status(status)
    .type("application/problem+json")
    .json({
      type: `https://api.rfpilot.example/problems/${known ? error.code.toLowerCase().replace(/_/g, "-") : "internal-error"}`,
      title: known ? error.message : "AI gateway operation failed",
      status,
      code: known ? error.code : "INTERNAL_ERROR",
    });
};
const uuid = (value: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(value))
    throw new AiGatewayError("AI_RUN_NOT_FOUND", "AI run was not found.", 404);
  return value;
};
export const createTestRun = async (req: AuthRequest, res: Response) => {
  try {
    if (process.env.AI_GATEWAY_ENABLED !== "true" || !durableJobsEnabled())
      throw new AiGatewayError(
        "AI_GATEWAY_DISABLED",
        "AI gateway durable execution is disabled.",
        503,
      );
    const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new AiGatewayError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required.",
        400,
      );
    const operation = String(req.body?.operation || "");
    if (!AI_OPERATIONS.includes(operation as AiOperation))
      throw new AiGatewayError(
        "INVALID_OPERATION",
        "Operation is not supported.",
        422,
      );
    const fixture = String(req.body?.fixture || "");
    if (!AI_SYNTHETIC_FIXTURES.includes(fixture as AiTestRequest["fixture"]))
      throw new AiGatewayError(
        "INVALID_FIXTURE",
        "Fixture must be an approved synthetic fixture name.",
        422,
      );
    const references = req.body?.evidenceReferences ?? [];
    if (
      !Array.isArray(references) ||
      references.length > 20 ||
      references.some((x: unknown) => typeof x !== "string" || x.length > 200)
    )
      throw new AiGatewayError(
        "INVALID_EVIDENCE_REFERENCES",
        "Evidence references are invalid.",
        422,
      );
    const c = context(req);
    const result = await durableJobRepository.createAiTest({
      ...c,
      operation,
      fixture,
      evidenceReferences: references,
      idempotencyKey,
      correlationId: String(
        req.headers["x-correlation-id"] || crypto.randomUUID(),
      ),
    });
    void durableJobDispatcher.dispatch().catch(() => undefined);
    res
      .status(result.created ? 202 : 200)
      .json({
        data: {
          ...result.job,
          created: result.created,
          statusUrl: `/api/v1/jobs/${result.job.id}`,
        },
      });
  } catch (error) {
    handle(res, error);
  }
};
export const getRun = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    res.json({
      data: await aiGatewayRepository.get(
        c.organizationMongoId,
        uuid(req.params.runId),
      ),
    });
  } catch (error) {
    handle(res, error);
  }
};
export const listRuns = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    res.json({
      data: await aiGatewayRepository.list(
        c.organizationMongoId,
        Math.min(Math.max(Number(req.query.limit) || 25, 1), 100),
      ),
    });
  } catch (error) {
    handle(res, error);
  }
};
const metadata =
  (read: (org: string) => Promise<unknown[]>) =>
  async (req: AuthRequest, res: Response) => {
    try {
      const c = context(req);
      res.json({ data: await read(c.organizationMongoId) });
    } catch (error) {
      handle(res, error);
    }
  };
export const listPolicies = metadata(aiGatewayRepository.policies);
export const listPrompts = metadata(aiGatewayRepository.prompts);
export const listSchemas = metadata(aiGatewayRepository.schemas);
export const listBudgets = metadata(aiGatewayRepository.budgets);
export const pilotStatus = async (req: AuthRequest, res: Response) => {
  try {
    context(req);
    res.json({ data: { enabled: process.env.NODE_ENV === "test" && process.env.LIVE_AI_PILOT_ENABLED === "true", provider: "openai", model: LIVE_AI_MODEL, credentialConfigured: Boolean(process.env.OPENAI_API_KEY), syntheticEnabled: process.env.LIVE_AI_SYNTHETIC_ENABLED === "true", nonConfidentialEnabled: process.env.LIVE_AI_NON_CONFIDENTIAL_ENABLED === "true", killSwitch: process.env.LIVE_AI_KILL_SWITCH === "true", inputTokenLimit: LIVE_AI_INPUT_TOKEN_LIMIT, outputTokenLimit: LIVE_AI_OUTPUT_TOKEN_LIMIT, commercialSpendCap: null, proposalMutation: false, publication: false } });
  } catch (error) { handle(res, error); }
};
