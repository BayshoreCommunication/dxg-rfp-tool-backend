import type { NextFunction, Request, Response } from "express";
import {
  PlanFeatureLockedError,
  PlanLimitReachedError,
  entitlementsOf,
  hasFeature,
  planIdOf,
  planTable,
  type OrganizationPlanState,
  type PlanFeature,
} from "../domain/plans";
import { loadOrganizationPlanState } from "../infrastructure/mongoOrganizationEntitlements";

// Every route file that gates a feature imports this module, so a malformed plan setting stops
// the API at startup instead of failing requests later.
planTable();

type AuthenticatedRequest = Request & { user?: { organizationId?: string } };
type LoadPlanState = (organizationId: string) => Promise<OrganizationPlanState | null>;

// Both API generations read this body: older routes use success/message, /api/v1 uses title/status.
const planErrorBody = (error: PlanLimitReachedError | PlanFeatureLockedError) => ({
  success: false,
  code: error.code,
  status: error.status,
  title: error.message,
  message: error.message,
  plan: error.plan,
  ...(error instanceof PlanLimitReachedError ? { limit: error.limit, created: error.created } : { feature: error.feature }),
});

/** Answers a plan refusal thrown by a use case. Returns false for any other error. */
export const respondIfPlanError = (res: Response, error: unknown): boolean => {
  if (!(error instanceof PlanLimitReachedError) && !(error instanceof PlanFeatureLockedError)) return false;
  res.status(error.status).json(planErrorBody(error));
  return true;
};

/* Route gate for one or more plan features (all are required). It goes after authenticate and
   reads the plan of the session's organization on every request, so a plan change applies at
   once and nothing in the request (path, query or body) can name another organization. The answer depends only on the caller's
   own organization, so a locked route says the same thing for a foreign id and a missing one. */
export const createRequirePlanFeature = (load: LoadPlanState) =>
  (...features: PlanFeature[]) => {
    const gate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const organizationId = (req as AuthenticatedRequest).user?.organizationId;
      if (!organizationId) {
        res.status(401).json({ success: false, message: "Authentication required" });
        return;
      }
      try {
        const organization = await load(organizationId);
        if (!organization) {
          res.status(403).json({ success: false, message: "Organization is inactive or unavailable" });
          return;
        }
        const locked = features.find((feature) => !hasFeature(organization, feature));
        if (locked) {
          respondIfPlanError(res, new PlanFeatureLockedError(planIdOf(organization), locked));
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    };
    // Lets tests/plan-entitlements.test.js check which routes carry the gate.
    return Object.assign(gate, { planFeatures: features });
  };

export const requirePlanFeature = createRequirePlanFeature(loadOrganizationPlanState);

/* GET /api/organization/entitlements: the caller's organization's plan, RFP usage against the
   limit, and which features are unlocked. Any member may read it; the dashboard uses it for the
   counter and the locked states (ORG-602). */
export const createGetEntitlements = (load: LoadPlanState) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const organization = await load((req as AuthenticatedRequest).user?.organizationId ?? "");
      if (!organization) {
        res.status(404).json({ success: false, code: "ORGANIZATION_NOT_FOUND", message: "Organization not found" });
        return;
      }
      res.status(200).json({ success: true, data: entitlementsOf(organization) });
    } catch (error) {
      console.error("Organization entitlements read error:", error instanceof Error ? error.name : "unknown");
      res.status(500).json({ success: false, code: "ENTITLEMENTS_ERROR", message: "Request failed" });
    }
  };

export const getEntitlements = createGetEntitlements(loadOrganizationPlanState);
