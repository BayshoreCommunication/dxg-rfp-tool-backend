import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { correlationId } from "./authController";
import { organizationProfile } from "../src/modules/organizationProfile/composition";
import type { OrganizationProfileRecord } from "../src/modules/organizationProfile/application/manageOrganizationProfile";
import { hasOrganizationAction } from "../src/modules/identity/domain/authorizationPolicy";

/* Mounted under /api/organization. Any member reads the profile; changing it and the onboarding
   steps need organization:manage. The organization is always the caller's session organization. */

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, code, message });

const handleError = (res: Response, error: unknown, context: string) => {
  console.error(`Organization profile ${context} error:`, error instanceof Error ? error.name : "unknown");
  fail(res, 500, "ORGANIZATION_PROFILE_ERROR", "Request failed");
};

const actor = (req: AuthRequest) => ({
  organizationId: req.user!.organizationId!,
  actorUserId: req.user!.userId,
  correlationId: correlationId(req),
});

const respond = (req: AuthRequest, res: Response, profile: OrganizationProfileRecord) =>
  res.status(200).json({
    success: true,
    ...profile,
    canManage: hasOrganizationAction(req.user!.roles ?? [], "organization:manage"),
  });

const FIELD_MESSAGES: Record<string, string> = {
  name: "Enter a company name of up to 200 characters",
  type: "Choose an organization type from the list",
  industry: "Keep the industry to 120 characters",
  country: "Choose a country from the list",
  timeZone: "Choose a time zone from the list",
  eventsPerYear: "Enter a whole number of events between 0 and 100,000",
};

const wrongStep = (res: Response, onboardingStep: string) =>
  res.status(409).json({
    success: false,
    code: "ONBOARDING_STEP_CONFLICT",
    message: "Finish the earlier onboarding steps first",
    onboardingStep,
  });

/* GET /api/organization/profile */
export const getOrganizationProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const profile = await organizationProfile.profile(req.user!.organizationId!);
    if (!profile) {
      fail(res, 404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return;
    }
    respond(req, res, profile);
  } catch (error) {
    handleError(res, error, "read");
  }
};

/* PUT /api/organization/profile { name, type?, industry?, country?, timeZone?, eventsPerYear? } */
export const updateOrganizationProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const result = await organizationProfile.updateDetails({ ...actor(req), details: body });
    if (result.kind === "validation") {
      res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: FIELD_MESSAGES[result.field], field: result.field });
      return;
    }
    if (result.kind === "not_found") {
      fail(res, 404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return;
    }
    respond(req, res, result.profile);
  } catch (error) {
    handleError(res, error, "update");
  }
};

/* POST /api/organization/onboarding/plan { plan } */
export const chooseOnboardingPlan = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await organizationProfile.choosePlan({ ...actor(req), plan: req.body?.plan });
    if (result.kind === "validation") {
      fail(res, 400, "VALIDATION_ERROR", "Choose an available plan");
      return;
    }
    if (result.kind === "not_found") {
      fail(res, 404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return;
    }
    if (result.kind === "wrong_step") {
      wrongStep(res, result.onboardingStep);
      return;
    }
    respond(req, res, result.profile);
  } catch (error) {
    handleError(res, error, "plan");
  }
};

/* POST /api/organization/onboarding/complete */
export const completeOnboarding = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await organizationProfile.completeOnboarding(actor(req));
    if (result.kind === "not_found") {
      fail(res, 404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return;
    }
    if (result.kind === "wrong_step") {
      wrongStep(res, result.onboardingStep);
      return;
    }
    respond(req, res, result.profile);
  } catch (error) {
    handleError(res, error, "complete");
  }
};
