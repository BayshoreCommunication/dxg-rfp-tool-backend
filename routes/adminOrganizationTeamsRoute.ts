import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth";
import { adminOrganizationTeamsController as controller } from "../controller/adminOrganizationTeamsController";
import { staffContentReads } from "./adminOrganizationContentRoute";

/* Mounted at /api/v1. RFPilot staff read ONE team of a customer organization, with its members.
   Staff do not change a customer organization's teams (owner decision, 2026-11-24;
   docs/DECISIONS.md): the create, rename, archive, team member and "member's teams" routes that
   were here from 2026-11-18 are removed, and tests/staff-organization-routes-guard.test.js fails
   if a write route comes back. The teams list is routes/adminOrganizationContentRoute.ts.

   Guard: the chain of the staff read routes (authenticate, a staff membership role, and in the
   service an `admins` account holding an admin role) and their read limit. The read is recorded
   in the staff organization's audit trail; nothing is written to the customer organization's. */
const router = Router();

const staff = [authenticate, authorize("admin", "super_admin", "superadmin")];

// The team with its members, each with the membership's `version`.
router.get("/admin/organizations/:organizationId/teams/:teamId", ...staff, staffContentReads, controller.team);

export default router;
