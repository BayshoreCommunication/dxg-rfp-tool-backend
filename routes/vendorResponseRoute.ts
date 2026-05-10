import { Router } from "express";
import mongoose from "mongoose";
import { Request, Response, NextFunction } from "express";
import {
  checkVendorResponseExists,
  submitVendorResponse,
  getVendorResponses,
  getVendorResponseById,
  markVendorResponseRead,
} from "../controller/vendorResponseController";
import { authenticate } from "../middleware/auth";
import { uploadVendorDocs } from "../middleware/upload";

const router = Router();

const validateResponseId = (req: Request, res: Response, next: NextFunction) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid response id" });
    return;
  }
  next();
};

/* Public routes — no authentication required */
router.get("/check", checkVendorResponseExists);
router.post("/", uploadVendorDocs, submitVendorResponse);

/* Protected routes — planner dashboard */
router.get("/", authenticate, getVendorResponses);
router.get("/:id", authenticate, validateResponseId, getVendorResponseById);
router.patch("/:id/read", authenticate, validateResponseId, markVendorResponseRead);

export default router;
