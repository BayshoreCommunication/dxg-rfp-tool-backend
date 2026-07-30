import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  historicalInsightsEnabled,
  HistoricalInsightsError,
  parseHistoricalReferenceIds,
} from "../src/modules/historicalInsights/domain";
import { historicalInsightsRepository } from "../src/modules/historicalInsights/postgresHistoricalInsightsRepository";

const proposalId = (value: string) => {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(id))
    throw new HistoricalInsightsError(
      "PROPOSAL_NOT_FOUND",
      "Proposal was not found.",
      404,
    );
  return id;
};

const context = (request: AuthRequest) => {
  if (!historicalInsightsEnabled())
    throw new HistoricalInsightsError(
      "HISTORICAL_INSIGHTS_DISABLED",
      "Historical proposal insights are disabled.",
      503,
    );
  if (!request.user?.organizationId || !request.user.userId)
    throw new HistoricalInsightsError(
      "AUTHENTICATION_REQUIRED",
      "Authentication required.",
      401,
    );
  return {
    organizationMongoId: request.user.organizationId,
    actorUserMongoId: request.user.userId,
    correlationId: String(
      request.headers["x-correlation-id"] || crypto.randomUUID(),
    ),
  };
};

const handle = (response: Response, error: unknown) => {
  const known = error instanceof HistoricalInsightsError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  response.status(status).type("application/problem+json").json({
    type: `https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title: known ? error.message : "Historical insight operation failed",
    status,
    code,
  });
};

export const generateHistoricalInsights = async (
  request: AuthRequest,
  response: Response,
) => {
  try {
    const currentProposalMongoId = proposalId(request.params.proposalId);
    const referenceProposalMongoIds = parseHistoricalReferenceIds(
      request.body?.referenceProposalIds,
      currentProposalMongoId,
    );
    response.status(201).json({
      data: await historicalInsightsRepository.generate({
        ...context(request),
        currentProposalMongoId,
        referenceProposalMongoIds,
      }),
    });
  } catch (error) {
    handle(response, error);
  }
};

export const latestHistoricalInsights = async (
  request: AuthRequest,
  response: Response,
) => {
  try {
    response.json({
      data: await historicalInsightsRepository.latest({
        ...context(request),
        currentProposalMongoId: proposalId(request.params.proposalId),
      }),
    });
  } catch (error) {
    handle(response, error);
  }
};
