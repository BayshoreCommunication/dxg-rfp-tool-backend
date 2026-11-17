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

// Per staff member, three allowances per 15 minutes. A refusal is 429 PLACEMENT_RATE_LIMITED,
// which is not PLACEMENT_CAPACITY_REACHED (another placement is running; try again shortly).
// - Reading a run is what the admin screen polls. At the recommended 3 s that is 300 per tab
//   per window; 1500 leaves room for a few tabs and faster polling.
// - The lists and the organization search (a typeahead) share 600.
// - A write queues a move and, in production, starts a task: 120.
const staffIdentity = (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown";
const limit = (name: string, allowance: number) =>
  securityRateLimit({ name, limit: allowance, windowMs: 15 * 60_000, identity: staffIdentity, code: "PLACEMENT_RATE_LIMITED" });
const runReads = limit("legacy-placement-run-read", 1500);
const listReads = limit("legacy-placement-read", 600);
const placementWrites = limit("legacy-placement-write", 120);

router.get("/", listReads, listLegacyCustomers);
router.get("/target-organizations", listReads, listPlacementTargets);
// Body: { target: "new", organization: { name, type?, industry?, country?, timeZone?, eventsPerYear? } }
//    or { target: "existing", organizationId, role: organization_admin|team_manager|planner, teamId? }
router.post("/:userId/placements", placementWrites, placeCustomer);
router.get("/placements/:runId", runReads, getPlacementRun);
router.post("/placements/:runId/rollback", placementWrites, rollbackPlacementRun);

export default router;
