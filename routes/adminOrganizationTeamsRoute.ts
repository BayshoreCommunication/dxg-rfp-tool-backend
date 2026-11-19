import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth";
import { adminOrganizationTeamsController as controller } from "../controller/adminOrganizationTeamsController";
import { staffContentReads } from "./adminOrganizationContentRoute";
import { staffMemberWrites } from "./adminOrganizationMembersRoute";

/* Mounted at /api/v1. RFPilot staff manage a customer organization's teams (owner decision,
   2026-11-18; docs/DECISIONS.md): create, rename and archive a team, add and remove a team
   member, set or unset a team manager, and set which teams a member is on. Teams only. Nothing
   here changes which team a proposal is on, edits or deletes a proposal's content, a template or
   the vendor list.

   Guard: the chain of the staff member routes (authenticate, a staff membership role, and in the
   service an `admins` account holding an admin role). Writes share the staff member routes'
   write limit: ONE budget of 60 writes per 15 minutes per staff account across member and team
   changes. Every request is recorded in the staff organization's audit trail; nothing is written
   to the customer organization's. */
const router = Router();

const staff = [authenticate, authorize("admin", "super_admin", "superadmin")];
const write = [...staff, staffMemberWrites];

// Body: { name, reason }.
router.post("/admin/organizations/:organizationId/teams", ...write, controller.create);
// The team with its members, and each member's `version` (which a change of that member's teams needs).
router.get("/admin/organizations/:organizationId/teams/:teamId", ...staff, staffContentReads, controller.team);
// Body: { name, reason }.
router.patch("/admin/organizations/:organizationId/teams/:teamId", ...write, controller.rename);
// Body: { reason }. No proposal is changed: proposals on the team keep it.
router.post("/admin/organizations/:organizationId/teams/:teamId/archive", ...write, controller.archive);
// Body: { userId, isManager?, reason }.
router.post("/admin/organizations/:organizationId/teams/:teamId/members", ...write, controller.addMember);
// Body: { isManager, reason }.
router.patch("/admin/organizations/:organizationId/teams/:teamId/members/:userId", ...write, controller.setManager);
// Body: { reason } (a JSON body on the DELETE; the reason is never in the URL).
router.delete("/admin/organizations/:organizationId/teams/:teamId/members/:userId", ...write, controller.removeMember);
// Body: { teamIds, version, reason } where version is the member's current membership version.
router.put("/admin/organizations/:organizationId/members/:userId/teams", ...write, controller.setMemberTeams);

export default router;
