import { Router } from "express";
import mongoose from "mongoose";
import type { Request, Response, NextFunction } from "express";
import {
  checkVendorResponseExists,
  getVendorResponseReceipt,
  submitVendorResponse,
  getVendorResponses,
  getVendorResponseProposals,
  getVendorResponseById,
  getVendorSubmissionDetail,
  markVendorResponseRead,
  recordVendorResponseOnBehalf,
} from "../controller/vendorResponseController";
import { authenticate, authorizeAction, type AuthRequest } from "../middleware/auth";
import { uploadVendorDocs } from "../middleware/upload";
import { requirePublicGrant } from "../middleware/publicAccess";
import {
  grantAndIpIdentity,
  securityRateLimit,
} from "../middleware/securityRateLimit";

const router = Router();
const publicGrantLimit = securityRateLimit({
  name: "vendor-public",
  limit: 60,
  windowMs: 15 * 60_000,
  identity: grantAndIpIdentity,
});

// The invite token remains bound to this proposal and operation. The vendor's
// response contact may be a different mailbox from the invitation recipient.
const alternateVendorContact = { allowAlternateVendorContact: true } as const;
const plannerWriteLimit = securityRateLimit({
  name: "vendor-response-write",
  limit: 60,
  windowMs: 15 * 60_000,
  // Runs after authenticate, so the planner — not a shared office IP — is the
  // subject of the limit.
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

const receiveVendorDocuments = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
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
};

const validateResponseId = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid response id" });
    return;
  }
  next();
};

/* Public routes — no authentication required */
router.get(
  "/check",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  checkVendorResponseExists,
);
router.get(
  "/receipt/:versionId",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  getVendorResponseReceipt,
);
router.post(
  "/",
  publicGrantLimit,
  receiveVendorDocuments,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  submitVendorResponse,
);

/* Protected routes — planner dashboard */
/* Authentication runs before the upload middleware so an anonymous caller can
   never stream files onto disk. */
router.post(
  "/manual",
  authenticate,
  authorizeAction("vendor-response:write"),
  plannerWriteLimit,
  receiveVendorDocuments,
  recordVendorResponseOnBehalf,
);
router.get(
  "/",
  authenticate,
  authorizeAction("vendor-response:read"),
  getVendorResponses,
);
router.get(
  "/proposals",
  authenticate,
  authorizeAction("vendor-response:read"),
  getVendorResponseProposals,
);
router.get(
  "/:id/submission-detail",
  authenticate,
  authorizeAction("vendor-response:read"),
  validateResponseId,
  getVendorSubmissionDetail,
);
router.get(
  "/:id",
  authenticate,
  authorizeAction("vendor-response:read"),
  validateResponseId,
  getVendorResponseById,
);
router.patch(
  "/:id/read",
  authenticate,
  authorizeAction("vendor-response:read"),
  validateResponseId,
  markVendorResponseRead,
);

export default router;
