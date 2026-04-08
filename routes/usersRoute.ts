import { Router } from "express";
import {
  deleteUser,
  getCurrentUser,
  getPrimaryAdminProfile,
  getUserById,
  getUsers,
  updateCurrentUser,
  updatePrimaryAdminProfile,
  updateUser,
} from "../controller/userController";
import { authenticate } from "../middleware/auth";

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get all users
router.get("/", getUsers);

// Get current authenticated user
router.get("/me", getCurrentUser);

// Update current authenticated user
router.put("/me", updateCurrentUser);

// Singleton admin profile (always one user)
router.get("/admin/profile", getPrimaryAdminProfile);
router.put("/admin/profile", updatePrimaryAdminProfile);

// Get user by ID
router.get("/:id", getUserById);

// Update user
router.put("/:id", updateUser);

// Delete user
router.delete("/:id", deleteUser);

export default router;
