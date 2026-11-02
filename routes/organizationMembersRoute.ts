import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { organizationMembersController as controller } from "../controller/organizationMembersController";

// ORG-206 membership management, mounted at /api/organization. Owners and Admins only: the
// organization:manage guard refuses everyone else with 403, and the use cases check again.
const router = Router();
router.use(authenticate, authorizeAction("organization:manage"));

router.get("/members", controller.list);
router.patch("/members/:userId/role", controller.changeRole);
// Body: { teamIds, version }. 503 TEAMS_UNAVAILABLE until ORG-201 lands.
router.put("/members/:userId/teams", controller.changeTeams);
router.post("/members/:userId/deactivate", controller.deactivate);
router.post("/members/:userId/reactivate", controller.reactivate);
// ORG-207. Body: { toUserId, rfpIds? } (omit rfpIds, or "all", to move every RFP the member owns).
router.post("/members/:userId/reassign-rfps", controller.reassignRfps);
// Body: { toUserId, version } where version is the new Owner's current membership version.
router.post("/ownership/transfer", controller.transferOwnership);

export default router;
