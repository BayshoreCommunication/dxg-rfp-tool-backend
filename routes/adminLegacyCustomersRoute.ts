import { Router } from "express";
import {
  getPlacementRun,
  listLegacyCustomers,
  listPlacementTargets,
  placeCustomer,
  rollbackPlacementRun,
} from "../controller/adminLegacyCustomersController";
import { authenticate, authorize } from "../middleware/auth";

// ORG-110: DXG staff place legacy customers into real organizations. Mounted at
// /api/admin/legacy-customers, DXG admins only.
const router = Router();
router.use(authenticate, authorize("admin", "super_admin", "superadmin"));

router.get("/", listLegacyCustomers);
router.get("/target-organizations", listPlacementTargets);
// Body: { target: "new", organization: { name, type?, industry?, country?, timeZone?, eventsPerYear? } }
//    or { target: "existing", organizationId, role: organization_admin|team_manager|planner, teamId? }
router.post("/:userId/placements", placeCustomer);
router.get("/placements/:runId", getPlacementRun);
router.post("/placements/:runId/rollback", rollbackPlacementRun);

export default router;
