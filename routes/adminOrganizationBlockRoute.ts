import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth";
import { adminOrganizationBlockController as controller } from "../controller/adminOrganizationBlockController";
import { staffMemberWrites } from "./adminOrganizationMembersRoute";

/* Mounted at /api/v1. RFPilot staff block a whole customer organization and reactivate it (owner
   decision, 2026-11-18; docs/DECISIONS.md). A block closes member sign-in and sessions, the
   organization's public links and its background work; data is kept and everything works again
   on reactivate. What "blocked" means and where it is enforced: src/modules/organizationBlock.

   Guard: the chain of the staff member and team routes (authenticate, a staff membership role,
   and in the service an `admins` account holding an admin role), and their write limit: member,
   team and block writes share ONE budget of 60 per 15 minutes per staff account. Every request is
   recorded in the staff organization's audit trail; nothing is written to the customer
   organization's. The staff organization is never blocked, so this guard keeps working. */
const router = Router();

const write = [authenticate, authorize("admin", "super_admin", "superadmin"), staffMemberWrites];

// Body: { reason }. Idempotent: answers `changed: false` when there was nothing to change.
router.post("/admin/organizations/:organizationId/block", ...write, controller.block);
router.post("/admin/organizations/:organizationId/reactivate", ...write, controller.reactivate);

export default router;
