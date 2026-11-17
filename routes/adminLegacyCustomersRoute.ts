import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import {
  getPlacementRun,
  listLegacyCustomers,
  listPlacementTargets,
  placeCustomer,
  rollbackPlacementRun,
} from "../controller/adminLegacyCustomersController";
import { authenticate, authorize, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { isPlanStaff } from "../src/modules/entitlements/application/manageOrganizationPlans";

// ORG-110: DXG staff place legacy customers into real organizations. Mounted at
// /api/admin/legacy-customers.
//
// Staff means both things, on every route here: a staff membership role, and an account in the
// `admins` collection with a staff account role (the same double check as plan management and
// support access). A membership role alone is not enough: a `users` account left holding a
// staff membership must not list every unplaced customer or queue a move.
const router = Router();

export const requireStaffAccount = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!isPlanStaff({ role: req.user?.role, accountType: req.user?.accountType })) {
    res.status(403).json({ success: false, code: "PLACEMENT_FORBIDDEN", message: "Only RFPilot staff can do that." });
    return;
  }
  next();
};
router.use(authenticate, authorize("admin", "super_admin", "superadmin"), requireStaffAccount);

// Per staff member. Reads are polled (a run every few seconds); a write queues a move and, in
// production, starts a task, so it gets a much smaller allowance.
const staffIdentity = (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown";
const placementReads = securityRateLimit({ name: "legacy-placement-read", limit: 600, windowMs: 15 * 60_000, identity: staffIdentity });
const placementWrites = securityRateLimit({ name: "legacy-placement-write", limit: 120, windowMs: 15 * 60_000, identity: staffIdentity });

router.get("/", placementReads, listLegacyCustomers);
router.get("/target-organizations", placementReads, listPlacementTargets);
// Body: { target: "new", organization: { name, type?, industry?, country?, timeZone?, eventsPerYear? } }
//    or { target: "existing", organizationId, role: organization_admin|team_manager|planner, teamId? }
router.post("/:userId/placements", placementWrites, placeCustomer);
router.get("/placements/:runId", placementReads, getPlacementRun);
router.post("/placements/:runId/rollback", placementWrites, rollbackPlacementRun);

export default router;
