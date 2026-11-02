import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { teamsController as controller } from "../controller/teamsController";

const router = Router();
const admin = [authenticate, authorizeAction("organization:manage")];

// Any member can list active team names (to pick a proposal's team); the rest is Owner/Admin only.
router.get("/teams", authenticate, controller.list);
router.post("/teams", ...admin, controller.create);
router.get("/teams/:teamId", ...admin, controller.get);
router.patch("/teams/:teamId", ...admin, controller.rename);
router.post("/teams/:teamId/archive", ...admin, controller.archive);
router.post("/teams/:teamId/members", ...admin, controller.addMember);
router.patch("/teams/:teamId/members/:userId", ...admin, controller.setManager);
router.delete("/teams/:teamId/members/:userId", ...admin, controller.removeMember);

export default router;
