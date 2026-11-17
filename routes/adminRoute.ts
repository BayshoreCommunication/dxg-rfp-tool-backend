import { Router } from "express";
import { getAdminOverview } from "../controller/adminController";
import { authenticate, authorize } from "../middleware/auth";

// RFPilot staff read customer proposals only under a support access grant
// (routes/supportAccessRoute.ts). This router carries no proposal route: the ungated
// GET /proposals and GET /proposals/:id were removed on 2026-11-17 (docs/DECISIONS.md).
const router = Router();

router.get(
  "/overview",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  getAdminOverview,
);

export default router;
