import { Router } from "express";
import { getAdminOverview } from "../controller/adminController";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();

router.get(
  "/overview",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  getAdminOverview,
);

export default router;
