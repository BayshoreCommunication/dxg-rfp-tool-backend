import { Router } from "express";
import {
  deleteSettings,
  getSettings,
  updateSettings,
} from "../controller/settingsController";
import { authenticate } from "../middleware/auth";
import { uploadSingle } from "../middleware/upload";

const router = Router();

// All settings routes require auth
router.get("/", authenticate, getSettings);
router.put("/", authenticate, uploadSingle("logoFile"), updateSettings);
router.delete("/", authenticate, deleteSettings);

export default router;
