import { Router } from "express";
import mongoose from "mongoose";
import type { Request, Response, NextFunction } from "express";
import {
  checkVendorResponseExists,
  configureVendorResponseRollout,
  getVendorResponseReceipt,
  submitVendorResponse,
  getVendorResponses,
  getVendorResponseProposals,
  getVendorResponseById,
  getVendorSubmissionDetail,
  exportVendorSubmissionVersion,
  markVendorResponseRead,
  recordVendorResponseOnBehalf,
  getVendorResponseWorkspace,
  publishVendorQuestionnaire,
  abandonVendorResponseDraft,
  createVendorResponseDraft,
  createVendorResponseRevisionDraft,
  finalizeVendorResponseDraft,
  getVendorResponseDraft,
  retireVendorResponseDraftDocument,
  saveVendorResponseDraft,
  uploadVendorResponseDraftDocuments,
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
  "/workspace",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", { allowRecipientlessVendorRead: true }),
  getVendorResponseWorkspace,
);
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
  "/drafts",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  createVendorResponseDraft,
);
router.get(
  "/drafts/:draftId",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  getVendorResponseDraft,
);
router.patch(
  "/drafts/:draftId",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  saveVendorResponseDraft,
);
router.post(
  "/drafts/:draftId/finalize",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  finalizeVendorResponseDraft,
);
/* Grant validation runs before multipart processing so unauthorized callers
   cannot stream draft files onto local disk. proposalId and the grant must be
   supplied in the query string or request headers for this endpoint. */
router.post(
  "/drafts/:draftId/documents",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  receiveVendorDocuments,
  uploadVendorResponseDraftDocuments,
);
router.delete(
  "/drafts/:draftId/documents/:documentId",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  retireVendorResponseDraftDocument,
);
router.delete(
  "/drafts/:draftId",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  abandonVendorResponseDraft,
);
router.post(
  "/:submissionId/revision-drafts",
  publicGrantLimit,
  requirePublicGrant("vendor:submit", alternateVendorContact),
  createVendorResponseRevisionDraft,
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
  "/questionnaires/publish",
  authenticate,
  authorizeAction("vendor-response:write"),
  plannerWriteLimit,
  publishVendorQuestionnaire,
);
router.patch(
  "/questionnaires/capability",
  authenticate,
  authorizeAction("vendor-response:write"),
  plannerWriteLimit,
  configureVendorResponseRollout,
);
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
  "/:id/submission-export",
  authenticate,
  authorizeAction("vendor-response:read"),
  validateResponseId,
  exportVendorSubmissionVersion,
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
