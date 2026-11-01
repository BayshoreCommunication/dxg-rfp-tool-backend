import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import { PUBLIC_GRANT_PURPOSES, type PublicGrantPurpose } from "../src/modules/publicAccess/domain/publicGrant";
import { publicAccess } from "../src/modules/publicAccess/composition";
import { respondIfProposalAccessDenied } from "../src/modules/identity/application/proposalAccess";

export const issuePublicAccess = async (req: AuthRequest, res: Response): Promise<void> => {
  const { resourceId, purpose, expiresInHours, maxUses, recipient } = req.body ?? {};
  if (!req.user?.organizationId || !req.user.userId) { res.status(401).json({ success: false, message: "Authentication required" }); return; }
  if (!mongoose.isValidObjectId(resourceId) || !PUBLIC_GRANT_PURPOSES.includes(purpose as PublicGrantPurpose)) {
    res.status(400).json({ success: false, message: "Valid resourceId and purpose are required" }); return;
  }
  if (purpose === "vendor:submit" && (typeof recipient !== "string" || !recipient.trim())) {
    res.status(400).json({ success: false, message: "Recipient is required for vendor submission grants" }); return;
  }
  // Express 4 doesn't forward async rejections, so every outcome is answered here.
  try {
    const grant = await publicAccess.issue({ organizationId: req.user.organizationId, createdByUserId: req.user.userId, resourceId, purpose, expiresInHours, maxUses, recipient });
    res.status(201).json({ success: true, grant });
  } catch (error) {
    if (respondIfProposalAccessDenied(res, error)) return;
    if (error instanceof Error && error.message === "Proposal not found for this organization") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }
    console.error("Issue public access error:", error);
    res.status(500).json({ success: false, message: "Could not create the access link" });
  }
};

export const revokePublicAccess = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?.organizationId) { res.status(401).json({ success: false, message: "Authentication required" }); return; }
  const revoked = await publicAccess.revoke(req.params.id, req.user.organizationId, "user_revoked");
  res.status(revoked ? 200 : 404).json({ success: revoked, message: revoked ? "Access revoked" : "Grant not found" });
};
