import { Router } from "express";
import {
  deleteUser,
  getUserById,
  getUsers,
  updateUser,
} from "../controller/userController";
import { authenticate } from "../middleware/auth";

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get all users
router.get("/", getUsers);

// Get user by ID
router.get("/:id", getUserById);

// Update user
router.put("/:id", updateUser);

// Delete user
router.delete("/:id", deleteUser);

export default router;
