import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  OnboardingFunnelError,
  onboardingFunnelReport,
  parseOnboardingFunnelFilters,
} from "../src/modules/dashboard/application/onboardingFunnelReport";

const writeProblem = (res: Response, error: unknown, correlationId: string) => {
  const known = error instanceof OnboardingFunnelError ? error : null;
  const status = known?.status ?? 500;
  const code = known?.code ?? "INTERNAL_ERROR";
  res
    .status(status)
    .type("application/problem+json")
    .json({
      type: `https://api.rfpilot.example/problems/${code
        .toLowerCase()
        .replace(/_/g, "-")}`,
      title: known?.message ?? "Onboarding funnel report failed",
      status,
      code,
      correlationId,
    });
};

export const getOnboardingFunnelReport = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const correlationId =
    (req as AuthRequest & { correlationId?: string }).correlationId ||
    String(req.headers["x-correlation-id"] || crypto.randomUUID());
  try {
    if (!req.user?.organizationId || !req.user.userId) {
      throw new OnboardingFunnelError(
        "AUTHENTICATION_REQUIRED",
        "Authentication required.",
        401,
      );
    }
    res.json({
      data: await onboardingFunnelReport(
        {
          organizationMongoId: req.user.organizationId,
          actorUserMongoId: req.user.userId,
          correlationId,
        },
        parseOnboardingFunnelFilters(req.query as Record<string, unknown>),
      ),
    });
  } catch (error) {
    writeProblem(res, error, correlationId);
  }
};
