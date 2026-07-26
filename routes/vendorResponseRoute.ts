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
import { authenticate, authorizeAction } from "../middleware/auth";
import { uploadVendorDocs } from "../middleware/upload";
import { requirePublicGrant } from "../middleware/publicAccess";
import { grantAndIpIdentity, securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const publicGrantLimit = securityRateLimit({ name: "vendor-public", limit: 60, windowMs: 15 * 60_000, identity: grantAndIpIdentity });

const validateResponseId = (req: Request, res: Response, next: NextFunction) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid response id" });
    return;
  }
  next();
};

/* Public routes — no authentication required */
router.get("/check", publicGrantLimit, requirePublicGrant("vendor:submit"), checkVendorResponseExists);
router.post(
  "/",
  publicGrantLimit,
  (req: Request, res: Response, next: NextFunction) => {
    uploadVendorDocs(req, res, (err: unknown) => {
      if (err) {
        const msg =
          err instanceof Error && err.message.includes("File too large")
            ? "One or more files exceed the 10 MB size limit."
            : err instanceof Error
              ? err.message
              : "File upload error.";
        res.status(400).json({ success: false, message: msg });
        return;
      }
      next();
    });
  },
  requirePublicGrant("vendor:submit"),
  submitVendorResponse,
);

/* Protected routes — planner dashboard */
router.get("/", authenticate, authorizeAction("vendor-response:read"), getVendorResponses);
router.get("/:id", authenticate, authorizeAction("vendor-response:read"), validateResponseId, getVendorResponseById);
router.patch("/:id/read", authenticate, authorizeAction("vendor-response:read"), validateResponseId, markVendorResponseRead);

export default router;
