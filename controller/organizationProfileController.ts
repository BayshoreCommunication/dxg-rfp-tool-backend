import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { correlationId } from "./authController";
import { organizationProfile } from "../src/modules/organizationProfile/composition";
import { hasOrganizationAction } from "../src/modules/identity/domain/authorizationPolicy";

/* Mounted under /api/organization. Any member reads the profile; renaming needs
   organization:manage. The organization is always the caller's session organization. */

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, code, message });

const handleError = (res: Response, error: unknown, context: string) => {
  console.error(`Organization profile ${context} error:`, error instanceof Error ? error.name : "unknown");
  fail(res, 500, "ORGANIZATION_PROFILE_ERROR", "Request failed");
};

/* GET /api/organization/profile */
export const getOrganizationProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const profile = await organizationProfile.profile(req.user!.organizationId!);
    if (!profile) {
      fail(res, 404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return;
    }
    const canEditName = hasOrganizationAction(req.user!.roles ?? [], "organization:manage");
    res.status(200).json({ success: true, name: profile.name, needsName: profile.needsName, canEditName });
  } catch (error) {
    handleError(res, error, "read");
  }
};

/* PUT /api/organization/profile { name } */
export const updateOrganizationProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await organizationProfile.rename({
      organizationId: req.user!.organizationId!,
      actorUserId: req.user!.userId,
      name: req.body?.name,
      correlationId: correlationId(req),
    });
    if (result.kind === "validation") {
      fail(res, 400, "VALIDATION_ERROR", "Enter a company name of up to 200 characters");
      return;
    }
    if (result.kind === "not_found") {
      fail(res, 404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return;
    }
    res.status(200).json({ success: true, name: result.name, needsName: result.needsName });
  } catch (error) {
    handleError(res, error, "update");
  }
};
