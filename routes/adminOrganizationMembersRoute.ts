import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorize, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { adminOrganizationMembersController as controller } from "../controller/adminOrganizationMembersController";
import { staffContentReads } from "./adminOrganizationContentRoute";

/* Mounted at /api/v1. RFPilot staff read ONE member of a customer organization. Staff do not
   change a customer organization's members (owner decision, 2026-11-24; docs/DECISIONS.md): the
   role, deactivate, reactivate, reassign-rfps and ownership transfer routes that were here from
   2026-11-18 are removed, and tests/staff-organization-routes-guard.test.js fails if a write
   route comes back. The members list is routes/adminOrganizationContentRoute.ts.

   Guard: the chain of the staff read routes (authenticate, a staff membership role, and in the
   service an `admins` account holding an admin role) and their read limit. The read is recorded
   in the staff organization's audit trail; nothing is written to the customer organization's. */
const router = Router();

/* The write limit of the staff organization routes. The one staff write left under
   /admin/organizations/:organizationId is blocking and reactivating the organization
   (routes/adminOrganizationBlockRoute.ts), which takes this limiter from here: 60 writes per
   15 minutes per staff account, stricter than the read limit. */
export const staffMemberWrites = securityRateLimit({
  name: "organization-member-write",
  limit: 60,
  windowMs: 15 * 60_000,
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

const staff = [authenticate, authorize("admin", "super_admin", "superadmin")];

// One member, with the membership's `version` (the members list does not carry it).
router.get("/admin/organizations/:organizationId/members/:userId", ...staff, staffContentReads, controller.member);

export default router;
