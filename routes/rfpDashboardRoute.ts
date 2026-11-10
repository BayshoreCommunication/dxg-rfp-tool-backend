import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { rfpDashboardController as controller } from "../controller/rfpDashboardController";

const router = Router();

router.get("/rfps", authenticate, authorizeAction("proposal:read"), controller.list);
router.get("/rfps/summary", authenticate, authorizeAction("proposal:read"), controller.summary);

export default router;
