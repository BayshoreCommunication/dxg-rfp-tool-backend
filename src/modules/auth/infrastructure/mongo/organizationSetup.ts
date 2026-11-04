import mongoose from "mongoose";
import Organization from "../../../../../modal/organizationModel";

/* An account created before Organization Accounts waits in a legacy holding tenant (ORG-107)
   until DXG places it in a real organization (ORG-110). It can't sign in or use a session until
   then: sign-in answers 403 and an existing session is ended, both with this code, so the
   dashboard can tell the person what to do. */
export const ORGANIZATION_SETUP_REQUIRED = {
  code: "ORGANIZATION_SETUP_REQUIRED",
  message:
    "Your account isn't part of an organization yet. Contact RFPilot support to create a new organization for you or to add you to your team's organization.",
} as const;

export const isAwaitingPlacement = async (organizationId: unknown): Promise<boolean> => {
  if (!mongoose.isValidObjectId(organizationId)) return false;
  return Boolean(await Organization.exists({ _id: organizationId, kind: "legacy_holding" }));
};
