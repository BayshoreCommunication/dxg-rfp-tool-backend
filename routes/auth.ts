import { Router } from "express";
import {
  getCurrentUser,
  signInWithCredentials,
  signOut,
  signUp,
} from "../controller/authController";
import { authenticate } from "../middleware/auth";

const router = Router();

// Public routes
router.post("/register", signUp);
router.post("/login", signInWithCredentials);

// Protected routes
router.get("/me", authenticate, getCurrentUser);
router.post("/logout", authenticate, signOut);

export default router;
