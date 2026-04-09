import { Router } from "express";
import {
  getSignedInAdminProfile,
  updateSignedInAdminProfile,
} from "../controller/adminUserRoute";
import { authenticate, authorize } from "../middleware/auth";
import { uploadSingle } from "../middleware/upload";

const router = Router();

router.get(
  "/me",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  getSignedInAdminProfile,
);

router.put(
  "/me",
  authenticate,
  authorize("admin", "super_admin", "superadmin"),
  uploadSingle("avatarFile"),
  updateSignedInAdminProfile,
);

export default router;
