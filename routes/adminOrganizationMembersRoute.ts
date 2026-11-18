import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorize, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { adminOrganizationMembersController as controller } from "../controller/adminOrganizationMembersController";
import { staffContentReads } from "./adminOrganizationContentRoute";

/* Mounted at /api/v1. RFPilot staff manage a customer organization's members (owner decision,
   2026-11-18; docs/DECISIONS.md): role, deactivate, reactivate, reassign the member's proposals,
   transfer ownership. Members only. Nothing here edits or deletes a proposal's content, a
   template or the vendor list; teams, invitations, two-factor reset and blocking are not built.

   Guard: the chain of the staff read routes (authenticate, a staff membership role, and in the
   service an `admins` account holding an admin role), plus a write limit of its own that is
   stricter than the read limit. Every request is recorded in the staff organization's audit
   trail; nothing is written to the customer organization's. */
const router = Router();

export const staffMemberWrites = securityRateLimit({
  name: "organization-member-write",
  limit: 60,
  windowMs: 15 * 60_000,
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

const staff = [authenticate, authorize("admin", "super_admin", "superadmin")];
const write = [...staff, staffMemberWrites];

// One member with its `version`, which every write below needs and the members list doesn't carry.
router.get("/admin/organizations/:organizationId/members/:userId", ...staff, staffContentReads, controller.member);
// Body: { role, version, reason }. Never to or from `owner`.
router.patch("/admin/organizations/:organizationId/members/:userId/role", ...write, controller.changeRole);
// Body: { version, reason }.
router.post("/admin/organizations/:organizationId/members/:userId/deactivate", ...write, controller.deactivate);
router.post("/admin/organizations/:organizationId/members/:userId/reactivate", ...write, controller.reactivate);
// Body: { toUserId, rfpIds?, reason } (omit rfpIds, or "all", to move every proposal the member owns).
router.post("/admin/organizations/:organizationId/members/:userId/reassign-rfps", ...write, controller.reassignRfps);
// Body: { toUserId, version, reason } where version is the new Owner's current membership version.
router.post("/admin/organizations/:organizationId/ownership/transfer", ...write, controller.transferOwnership);

export default router;
