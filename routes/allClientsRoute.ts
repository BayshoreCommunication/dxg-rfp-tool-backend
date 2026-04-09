import { Router } from "express";
import { getAdminClientsList } from "../controller/allClientsController";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();

// Admin only - paginated clients list with search and counts
router.get(
  "/",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  getAdminClientsList,
);

export default router;
