import { hasOrganizationAction } from "./authorizationPolicy";
import { canAccessRfp, type RfpActor, type RfpRef } from "./rfpAccessPolicy";

// What the signed-in member may do to one listed proposal, for the lists' row actions. Nothing is
// decided here: each flag is the answer the mutation endpoint itself would give, built from the
// same two checks that endpoint runs (the route's `proposal:write` capability and the access
// policy action its query is scoped by). The flags describe permission, not state: canArchive on
// an archived proposal means the member may restore it.
//
//   canEdit       PUT    /api/proposals/:id            proposal:write + policy "edit"
//   canDuplicate  POST   /api/proposals/:id/copy       proposal:write + policy "view" (the source is only read)
//   canArchive    DELETE /api/proposals/:id and
//                 PATCH  /api/proposals/:id/restore    proposal:write + policy "archive"
//
// A copy also needs a free slot on the organization's plan; that is not a per-proposal fact and
// is not part of canDuplicate.
export type RfpRowPermissions = { canEdit: boolean; canDuplicate: boolean; canArchive: boolean };

export const rfpRowPermissions = (actor: RfpActor, rfp: RfpRef): RfpRowPermissions => {
  const mayWrite = hasOrganizationAction(actor.roles, "proposal:write");
  const allows = (action: "view" | "edit" | "archive") => mayWrite && canAccessRfp(actor, rfp, action).allowed;
  return { canEdit: allows("edit"), canDuplicate: allows("view"), canArchive: allows("archive") };
};
