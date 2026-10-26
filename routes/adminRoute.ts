import { Router } from "express";
import {
  getAdminOverview,
  getAdminProposalDetail,
  getAdminProposals,
} from "../controller/adminController";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();

router.get(
  "/overview",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  getAdminOverview,
);

router.get(
  "/proposals",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  getAdminProposals,
);

router.get(
  "/proposals/:id",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  getAdminProposalDetail,
);

export default router;
