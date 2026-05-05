import { Router } from "express";
import {
  createAdminUser,
  deleteAdminUser,
  getAdminUsers,
  updateAdminUser,
} from "../controller/adminUsersController";
import {
  getSignedInAdminProfile,
  updateSignedInAdminProfile,
} from "../controller/adminUserRoute";
import { authenticate, authorize } from "../middleware/auth";
import { uploadSingle } from "../middleware/upload";

const router = Router();

const adminGuard = [authenticate, authorize("admin", "super_admin", "superadmin")];
const superAdminGuard = [authenticate, authorize("super_admin", "superadmin")];

// Signed-in admin profile (any admin)
router.get("/me", ...adminGuard, getSignedInAdminProfile);
router.put("/me", ...adminGuard, uploadSingle("avatarFile"), updateSignedInAdminProfile);

// Admin user management (super admin only)
router.get("/", ...superAdminGuard, getAdminUsers);
router.post("/", ...superAdminGuard, createAdminUser);
router.put("/:id", ...superAdminGuard, updateAdminUser);
router.delete("/:id", ...superAdminGuard, deleteAdminUser);

export default router;
