import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth";
import { adminOrganizationBlockController as controller } from "../controller/adminOrganizationBlockController";
import { staffMemberWrites } from "./adminOrganizationMembersRoute";

/* Mounted at /api/v1. RFPilot staff block a whole customer organization and reactivate it (owner
   decision, 2026-11-18; docs/DECISIONS.md). A block closes member sign-in and sessions, the
   organization's public links and its background work; data is kept and everything works again
   on reactivate. What "blocked" means and where it is enforced: src/modules/organizationBlock.

   These are the only staff routes under /admin/organizations/:organizationId that are not a GET
   (tests/staff-organization-routes-guard.test.js): staff do not change an organization's members
   or teams (owner decision, 2026-11-24).

   Guard: the chain of the staff read routes (authenticate, a staff membership role, and in the
   service an `admins` account holding an admin role), and the staff write limit: 60 writes per
   15 minutes per staff account (`staffMemberWrites`, routes/adminOrganizationMembersRoute.ts). Every request is
   recorded in the staff organization's audit trail; nothing is written to the customer
   organization's. The service refuses the caller's own organization, so a staff account cannot
   block the organization it signs in to. */
const router = Router();

const write = [authenticate, authorize("admin", "super_admin", "superadmin"), staffMemberWrites];

// Body: { reason }. Idempotent: answers `changed: false` when there was nothing to change.
router.post("/admin/organizations/:organizationId/block", ...write, controller.block);
router.post("/admin/organizations/:organizationId/reactivate", ...write, controller.reactivate);

export default router;
