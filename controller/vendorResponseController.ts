import type { Request, Response } from "express";
import mongoose from "mongoose";
import type { AuthRequest } from "../middleware/auth";
import type { PublicGrantRequest } from "../middleware/publicAccess";
import {
  checkVendorResponse,
  getVendorSubmissionReceipt,
  getOwnedVendorSubmissionDetail,
  getOwnedVendorResponse,
  listOwnedVendorResponseProposals,
  listOwnedVendorResponses,
  recordManualVendorResponse,
  submitPublicVendorResponse,
  getPublicVendorResponseWorkspace,
  publishVendorResponseQuestionnaire,
  abandonPublicVendorResponseDraft,
  createOrResumePublicVendorResponseDraft,
  createOrResumePublicVendorResponseRevisionDraft,
  finalizePublicVendorResponseDraft,
  getPublicVendorResponseDraft,
  retirePublicVendorResponseDraftDocument,
  savePublicVendorResponseDraft,
  uploadPublicVendorResponseDraftDocuments,
} from "../src/modules/vendorResponses/composition";
import { VendorResponseWorkspaceError } from "../src/modules/vendorResponses/application/vendorResponseWorkspace";
import { VendorSubmissionDraftError } from "../src/modules/vendorResponses/application/vendorSubmissionDrafts";
import { VendorSubmissionFinalizationError } from "../src/modules/vendorResponses/application/finalizeVendorSubmissionDraft";
import type {
  VendorDraftDocumentScopeType,
  VendorSubmissionDraftScope,
} from "../src/modules/vendorResponses/domain/draft";

const sendWorkspaceError = (
  res: Response,
  error: unknown,
  fallback: string,
): void => {
  if (error instanceof VendorResponseWorkspaceError) {
    res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }
  res.status(500).json({ success: false, message: fallback });
};

const sendDraftError = (
  res: Response,
  error: unknown,
  fallback: string,
): void => {
  if (error instanceof VendorSubmissionDraftError) {
    res.status(error.status).json({
      success: false,
      code: error.code.toLowerCase(),
      message: error.message,
      ...(error.latestDraftRevision === undefined
        ? {}
        : { latestDraftRevision: error.latestDraftRevision }),
      ...(error.issues ? { errors: error.issues } : {}),
    });
    return;
  }
  if (error instanceof VendorSubmissionFinalizationError) {
    res.status(error.status).json({
      success: false,
      code: error.code.toLowerCase(),
      message: error.message,
      ...(error.latestDraftRevision === undefined
        ? {}
        : { latestDraftRevision: error.latestDraftRevision }),
      ...(error.issues ? { errors: error.issues } : {}),
    });
    return;
  }
  sendWorkspaceError(res, error, fallback);
};

const proposalIdFrom = (req: Request): string => {
  if (typeof req.query.proposalId === "string") return req.query.proposalId;
  if (typeof req.body?.proposalId === "string") return req.body.proposalId;
  return "";
};

const draftRevisionFrom = (req: Request): number | null => {
  const value = req.body?.draftRevision ?? req.query.draftRevision;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
};

const draftScopeFrom = (
  req: PublicGrantRequest,
  proposalId: string,
): VendorSubmissionDraftScope | null => {
  const grant = req.publicGrant;
  if (
    !grant
    || grant.purpose !== "vendor:submit"
    || grant.resourceId !== proposalId
    || !mongoose.isValidObjectId(grant.id)
    || typeof grant.recipientHash !== "string"
    || !/^[0-9a-f]{64}$/.test(grant.recipientHash)
  ) return null;
  return {
    organizationId: grant.organizationId,
    proposalId,
    grantId: grant.id,
    grantSubjectHash: grant.recipientHash,
  };
};

const validDraftRequest = (
  req: PublicGrantRequest,
  res: Response,
): VendorSubmissionDraftScope | null => {
  const proposalId = proposalIdFrom(req);
  if (!mongoose.isValidObjectId(proposalId)) {
    res.status(400).json({ success: false, message: "Valid proposal id is required." });
    return null;
  }
  const scope = draftScopeFrom(req, proposalId);
  if (!scope) {
    res.status(403).json({
      success: false,
      message: "Vendor draft access is unavailable.",
    });
    return null;
  }
  return scope;
};

export const getVendorResponseWorkspace = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const proposalId = typeof req.query.proposalId === "string"
      ? req.query.proposalId
      : "";
    const grant = req.publicGrant;
    if (!mongoose.isValidObjectId(proposalId)) {
      res.status(400).json({ success: false, message: "Valid proposal id is required." });
      return;
    }
    if (!grant || grant.purpose !== "vendor:submit" || grant.resourceId !== proposalId) {
      res.status(403).json({ success: false, message: "Vendor workspace access is unavailable." });
      return;
    }
    const workspace = await getPublicVendorResponseWorkspace({
      organizationId: grant.organizationId,
      proposalId,
      grantActorId: grant.createdByUserId,
      grantId: grant.id,
      grantSubjectHash: grant.recipientHash ?? "",
    });
    res.status(200).json({ success: true, data: workspace });
  } catch (error) {
    sendWorkspaceError(res, error, "Vendor workspace is temporarily unavailable.");
  }
};

export const createVendorResponseDraft = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope || !req.publicGrant) return;
    const result = await createOrResumePublicVendorResponseDraft({
      ...scope,
      grantActorId: req.publicGrant.createdByUserId,
    });
    res.status(result.created ? 201 : 200).json({
      success: true,
      created: result.created,
      data: result.draft,
    });
  } catch (error) {
    sendDraftError(res, error, "Vendor response draft could not be created.");
  }
};

export const createVendorResponseRevisionDraft = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope || !req.publicGrant) return;
    if (!mongoose.isValidObjectId(req.params.submissionId)) {
      res.status(400).json({ success: false, message: "Valid submission id is required." });
      return;
    }
    const result = await createOrResumePublicVendorResponseRevisionDraft({
      ...scope,
      grantActorId: req.publicGrant.createdByUserId,
      submissionId: req.params.submissionId,
    });
    res.status(result.created ? 201 : 200).json({
      success: true,
      created: result.created,
      data: result.draft,
    });
  } catch (error) {
    sendDraftError(res, error, "Vendor response revision draft could not be created.");
  }
};

export const getVendorResponseDraft = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope) return;
    if (!mongoose.isValidObjectId(req.params.draftId)) {
      res.status(400).json({ success: false, message: "Valid draft id is required." });
      return;
    }
    const draft = await getPublicVendorResponseDraft(scope, req.params.draftId);
    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    sendDraftError(res, error, "Vendor response draft could not be loaded.");
  }
};

export const saveVendorResponseDraft = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope) return;
    const draftRevision = draftRevisionFrom(req);
    if (!mongoose.isValidObjectId(req.params.draftId) || draftRevision === null) {
      res.status(400).json({
        success: false,
        message: "Valid draft id and draft revision are required.",
      });
      return;
    }
    const draft = await savePublicVendorResponseDraft({
      ...scope,
      draftId: req.params.draftId,
      expectedRevision: draftRevision,
      response: req.body?.response,
    });
    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    sendDraftError(res, error, "Vendor response draft could not be saved.");
  }
};

const documentScopeTypes = new Set<VendorDraftDocumentScopeType>([
  "proposal",
  "room",
  "crew_member",
  "reference",
]);

export const uploadVendorResponseDraftDocuments = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope) return;
    const draftRevision = draftRevisionFrom(req);
    const purposeId = typeof req.body?.purposeId === "string"
      ? req.body.purposeId.trim()
      : "";
    const scopeType = req.body?.scopeType as VendorDraftDocumentScopeType;
    const scopeId = typeof req.body?.scopeId === "string" && req.body.scopeId.trim()
      ? req.body.scopeId.trim()
      : undefined;
    if (
      !mongoose.isValidObjectId(req.params.draftId)
      || draftRevision === null
      || !purposeId
      || !documentScopeTypes.has(scopeType)
    ) {
      res.status(400).json({
        success: false,
        message: "Valid draft revision, document purpose, and scope are required.",
      });
      return;
    }
    const result = await uploadPublicVendorResponseDraftDocuments({
      ...scope,
      draftId: req.params.draftId,
      expectedRevision: draftRevision,
      purposeId,
      scopeType,
      scopeId,
      files: uploadedVendorDocuments(req),
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    sendDraftError(res, error, "Vendor response documents could not be uploaded.");
  }
};

export const retireVendorResponseDraftDocument = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope) return;
    const draftRevision = draftRevisionFrom(req);
    if (!mongoose.isValidObjectId(req.params.draftId) || draftRevision === null) {
      res.status(400).json({
        success: false,
        message: "Valid draft id and draft revision are required.",
      });
      return;
    }
    const draft = await retirePublicVendorResponseDraftDocument({
      ...scope,
      draftId: req.params.draftId,
      documentId: req.params.documentId,
      expectedRevision: draftRevision,
    });
    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    sendDraftError(res, error, "Vendor response document could not be retired.");
  }
};

export const abandonVendorResponseDraft = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope) return;
    const draftRevision = draftRevisionFrom(req);
    if (!mongoose.isValidObjectId(req.params.draftId) || draftRevision === null) {
      res.status(400).json({
        success: false,
        message: "Valid draft id and draft revision are required.",
      });
      return;
    }
    const draft = await abandonPublicVendorResponseDraft({
      ...scope,
      draftId: req.params.draftId,
      expectedRevision: draftRevision,
    });
    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    sendDraftError(res, error, "Vendor response draft could not be abandoned.");
  }
};

export const finalizeVendorResponseDraft = async (
  req: PublicGrantRequest,
  res: Response,
): Promise<void> => {
  try {
    const scope = validDraftRequest(req, res);
    if (!scope || !req.publicGrant) return;
    const draftRevision = draftRevisionFrom(req);
    if (!mongoose.isValidObjectId(req.params.draftId) || draftRevision === null) {
      res.status(400).json({
        success: false,
        message: "Valid draft id and draft revision are required.",
      });
      return;
    }
    const result = await finalizePublicVendorResponseDraft({
      ...scope,
      grantActorId: req.publicGrant.createdByUserId,
      draftId: req.params.draftId,
      expectedRevision: draftRevision,
      idempotencyKey:
        req.body?.submissionIdempotencyKey ?? req.headers["idempotency-key"],
    });
    res.status(result.kind === "duplicate" ? 200 : 201).json({
      success: true,
      isReplay: result.kind === "duplicate",
      message: result.kind === "duplicate"
        ? "This draft was already submitted. The original receipt is shown below."
        : result.receipt.versionNumber > 1
          ? `Version ${result.receipt.versionNumber} of your response has been received.`
          : "Your response has been submitted successfully.",
      data: {
        submissionId: result.receipt.submissionId,
        versionId: result.receipt.versionId,
        versionNumber: result.receipt.versionNumber,
        parentVersionId: result.receipt.parentVersionId,
        reason: result.receipt.reason,
        receivedAt: result.receipt.receivedAt,
        manifestChecksum: result.receipt.manifestChecksum,
        responseSchemaVersion: result.receipt.responseSchemaVersion,
        questionnaire: result.receipt.questionnaire,
        calculation: result.receipt.calculationSnapshot,
        retiredDocuments: result.receipt.retiredDocuments,
        documents: result.receipt.documents.map((document) => ({
          documentId: document.documentId,
          sourceId: document.sourceId,
          name: document.name,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes,
          sha256: document.sha256,
          scanStatus: document.scanStatus,
          purposeId: document.purposeId,
          scopeType: document.scopeType,
          scopeId: document.scopeId,
          disposition: document.versionDisposition,
        })),
        sourceRegistration: result.sourceRegistration,
      },
    });
  } catch (error) {
    sendDraftError(res, error, "Vendor response draft could not be finalized.");
  }
};

export const publishVendorQuestionnaire = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const proposalId = typeof req.body?.proposalId === "string"
      ? req.body.proposalId
      : "";
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    if (!userId || !organizationId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    if (!mongoose.isValidObjectId(proposalId)) {
      res.status(400).json({ success: false, message: "Valid proposal id is required." });
      return;
    }
    const result = await publishVendorResponseQuestionnaire({
      organizationId,
      proposalId,
      actorId: userId,
      ownerUserId: userId,
    });
    res.status(result.publication.created ? 201 : 200).json({
      success: true,
      created: result.publication.created,
      data: result.publication.questionnaire,
    });
  } catch (error) {
    sendWorkspaceError(res, error, "Vendor questionnaire could not be published.");
  }
};

export const checkVendorResponseExists = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { proposalId, email, emailTrackingId } = req.query as {
      proposalId?: string;
      email?: string;
      emailTrackingId?: string;
    };

    if (
      !emailTrackingId?.trim() &&
      (!proposalId || !mongoose.isValidObjectId(proposalId) || !email?.trim())
    ) {
      res.status(200).json({ alreadySubmitted: false, existingResponse: null });
      return;
    }
    const result = await checkVendorResponse({
      proposalId,
      email,
      trackingId: emailTrackingId,
    });
    res.status(200).json(result);
  } catch {
    res.status(200).json({ alreadySubmitted: false, existingResponse: null });
  }
};

type VendorSubmissionOutcome = Awaited<
  ReturnType<typeof submitPublicVendorResponse>
>;

/* The same outcome is reported to two very different audiences: the vendor who
   filled in the public portal, and the planner who typed the response in for
   them. Only the wording differs. */
type SubmissionCopy = {
  created: string;
  updated: (versionNumber: number) => string;
  replay: string;
};

const vendorSubmissionCopy: SubmissionCopy = {
  created: "Your response has been submitted successfully.",
  updated: (versionNumber) =>
    `Version ${versionNumber} of your response has been received.`,
  replay:
    "This submission was already received. Your original receipt is shown below.",
};

const plannerSubmissionCopy: SubmissionCopy = {
  created: "The vendor response was recorded.",
  updated: (versionNumber) =>
    `Version ${versionNumber} was recorded for this vendor.`,
  replay:
    "This response was already recorded, so the existing version is unchanged.",
};

const missingSubmissionField = (input: {
  vendorName?: string;
  submittedBy?: string;
  email?: string;
}): string | null => {
  if (!input.vendorName?.trim()) return "Vendor name is required.";
  if (!input.submittedBy?.trim()) return "Submitted by is required.";
  if (!input.email?.trim()) return "Email is required.";
  return null;
};

const uploadedVendorDocuments = (req: Request) => {
  const rawFiles = (
    req as Request & {
      files?: {
        documents?: Array<{
          originalname: string;
          path: string;
          mimetype?: string;
          size?: number;
        }>;
      };
    }
  ).files?.documents;
  return Array.isArray(rawFiles)
    ? rawFiles.map(({ originalname, path, mimetype, size }) => ({
        originalname,
        path,
        mimetype,
        size,
      }))
    : [];
};

const sendSubmissionOutcome = (
  res: Response,
  result: VendorSubmissionOutcome,
  copy: SubmissionCopy,
): void => {
  if (result.kind === "proposal_not_found") {
    res.status(404).json({ success: false, message: "Proposal not found." });
    return;
  }
  if (result.kind === "forbidden") {
    res.status(403).json({
      success: false,
      message: "You don't have access to this proposal.",
    });
    return;
  }
  if (result.kind === "infected") {
    res.status(422).json({
      success: false,
      message:
        "One or more uploaded files failed the malware scan and the submission was rejected.",
    });
    return;
  }
  // Fail-closed: the scan could not be performed, so the files are refused
  // rather than stored unscanned. 503 (not 422) because the submission is
  // valid and retrying once the scanner is healthy is the correct action.
  if (result.kind === "scan_unavailable") {
    res.status(503).json({
      success: false,
      message:
        "Uploads cannot be virus-scanned right now, so the submission was not accepted. Please try again shortly.",
    });
    return;
  }
  if (result.kind === "invalid") {
    const labels = {
      vendorName: "Vendor name",
      submittedBy: "Submitted by",
      email: "Email",
    };
    res.status(400).json({
      success: false,
      message: `${labels[result.field]} is required.`,
    });
    return;
  }
  const isUpdate = result.submission.versionNumber > 1;
  const isReplay = result.kind === "duplicate";
  res.status(isReplay ? 200 : 201).json({
    success: true,
    isUpdate,
    isReplay,
    message: isReplay
      ? copy.replay
      : isUpdate
        ? copy.updated(result.submission.versionNumber)
        : copy.created,
    data: result.response,
    submission: {
      submissionId: result.submission.submissionId,
      versionId: result.submission.versionId,
      versionNumber: result.submission.versionNumber,
      parentVersionId: result.submission.parentVersionId,
      reason: result.submission.reason,
      receivedAt: result.submission.receivedAt,
      manifestChecksum: result.submission.manifestChecksum,
      sourceRegistration: result.sourceRegistration,
    },
  });
};

export const submitVendorResponse = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const {
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      emailTrackingId,
      submissionIdempotencyKey,
      submissionReason,
    } = req.body as {
      proposalId?: string;
      vendorName?: string;
      submittedBy?: string;
      email?: string;
      message?: string;
      emailTrackingId?: string;
      submissionIdempotencyKey?: string;
      submissionReason?: string;
    };

    if (!proposalId || !mongoose.isValidObjectId(proposalId)) {
      res
        .status(400)
        .json({ success: false, message: "Valid proposal id is required." });
      return;
    }
    const missingField = missingSubmissionField({
      vendorName,
      submittedBy,
      email,
    });
    if (missingField) {
      res.status(400).json({ success: false, message: missingField });
      return;
    }

    const result = await submitPublicVendorResponse({
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      trackingId: emailTrackingId,
      idempotencyKey:
        submissionIdempotencyKey || req.headers["idempotency-key"],
      reason: submissionReason,
      files: uploadedVendorDocuments(req),
    });
    sendSubmissionOutcome(res, result, vendorSubmissionCopy);
  } catch (error) {
    console.error("Submit vendor response error:", error);
    res.status(500).json({
      success: false,
      message: "Error submitting vendor response",
    });
  }
};

/* Planner records a response a vendor sent outside the portal (email, courier,
   in person). It joins the same submission/version chain the portal writes, so
   a vendor that later submits online continues from this version. */
export const recordVendorResponseOnBehalf = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }
    const {
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      submissionIdempotencyKey,
      submissionReason,
    } = req.body as {
      proposalId?: string;
      vendorName?: string;
      submittedBy?: string;
      email?: string;
      message?: string;
      submissionIdempotencyKey?: string;
      submissionReason?: string;
    };

    if (!proposalId || !mongoose.isValidObjectId(proposalId)) {
      res
        .status(400)
        .json({ success: false, message: "Valid proposal id is required." });
      return;
    }
    const missingField = missingSubmissionField({
      vendorName,
      submittedBy,
      email,
    });
    if (missingField) {
      res.status(400).json({ success: false, message: missingField });
      return;
    }

    const result = await recordManualVendorResponse({
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      idempotencyKey:
        submissionIdempotencyKey || req.headers["idempotency-key"],
      reason: submissionReason,
      recordedByUserId: userId,
      files: uploadedVendorDocuments(req),
    });
    sendSubmissionOutcome(res, result, plannerSubmissionCopy);
  } catch (error) {
    console.error("Record vendor response error:", error);
    res.status(500).json({
      success: false,
      message: "Error recording vendor response",
    });
  }
};

export const getVendorResponseReceipt = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const proposalId =
      typeof req.query.proposalId === "string" ? req.query.proposalId : "";
    const email =
      typeof req.query.email === "string"
        ? req.query.email.trim().toLowerCase()
        : "";
    const versionId = req.params.versionId;
    if (
      !mongoose.isValidObjectId(proposalId) ||
      !mongoose.isValidObjectId(versionId) ||
      !email
    ) {
      res
        .status(400)
        .json({
          success: false,
          message: "A valid proposal, receipt, and vendor email are required.",
        });
      return;
    }
    const receipt = await getVendorSubmissionReceipt({
      proposalId,
      versionId,
      email,
    });
    if (!receipt) {
      res
        .status(404)
        .json({ success: false, message: "Submission receipt not found." });
      return;
    }
    res.status(200).json({
      success: true,
      data: {
        submissionId: receipt.submissionId,
        versionId: receipt.versionId,
        versionNumber: receipt.versionNumber,
        parentVersionId: receipt.parentVersionId,
        reason: receipt.reason,
        receivedAt: receipt.receivedAt,
        manifestChecksum: receipt.manifestChecksum,
        proposalId: receipt.proposalId,
        proposalTitle: receipt.proposalTitle,
        vendorName: receipt.vendorName,
        submittedBy: receipt.submittedBy,
        email: receipt.email,
        documents: receipt.documents.map((document) => ({
          documentId: document.documentId,
          name: document.name,
          sizeBytes: document.sizeBytes,
          sha256: document.sha256,
          scanStatus: document.scanStatus,
        })),
      },
    });
  } catch {
    res
      .status(500)
      .json({
        success: false,
        message: "Submission receipt is temporarily unavailable.",
      });
  }
};

export const getVendorResponses = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    const { page, limit, unreadOnly, proposalId, campaignId } = req.query;
    if (
      (typeof proposalId === "string" && !mongoose.isValidObjectId(proposalId)) ||
      (typeof campaignId === "string" && !mongoose.isValidObjectId(campaignId))
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid vendor response filter",
      });
      return;
    }
    const result = await listOwnedVendorResponses({
      ownerUserId: userId,
      query: {
        page: typeof page === "string" ? page : undefined,
        limit: typeof limit === "string" ? limit : undefined,
        unreadOnly: typeof unreadOnly === "string" ? unreadOnly : undefined,
        proposalId:
          typeof proposalId === "string" && mongoose.isValidObjectId(proposalId)
            ? proposalId
            : undefined,
        campaignId:
          typeof campaignId === "string" && mongoose.isValidObjectId(campaignId)
            ? campaignId
            : undefined,
      },
    });

    res.status(200).json({
      success: true,
      data: result.responses,
      pagination: result.pagination,
      unreadCount: result.unreadCount,
      filteredUnreadCount: result.filteredUnreadCount,
    });
  } catch (error) {
    console.error("Get vendor responses error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor responses",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getVendorResponseProposals = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    const { page, limit, search } = req.query;
    const result = await listOwnedVendorResponseProposals({
      ownerUserId: userId,
      query: {
        page: typeof page === "string" ? page : undefined,
        limit: typeof limit === "string" ? limit : undefined,
        search: typeof search === "string" ? search : undefined,
      },
    });
    res.status(200).json({
      success: true,
      data: result.proposals,
      pagination: result.pagination,
      responseCount: result.responseCount,
      unreadCount: result.unreadCount,
    });
  } catch (error) {
    console.error("Get vendor response proposals error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor response proposals",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getVendorResponseById = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ success: false, message: "Invalid response id" });
      return;
    }

    const result = await getOwnedVendorResponse({
      responseId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res
        .status(404)
        .json({ success: false, message: "Vendor response not found" });
      return;
    }

    res.status(200).json({ success: true, data: result.response });
  } catch (error) {
    console.error("Get vendor response by id error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor response",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getVendorSubmissionDetail = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await getOwnedVendorSubmissionDetail({
      responseId: req.params.id,
      ownerUserId: userId,
    });
    if (result.kind === "not_found") {
      res
        .status(404)
        .json({ success: false, message: "Vendor response not found" });
      return;
    }
    res.status(200).json({ success: true, data: result.detail });
  } catch (error) {
    console.error("Get vendor submission detail error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor submission detail",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const markVendorResponseRead = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ success: false, message: "Invalid response id" });
      return;
    }

    const result = await getOwnedVendorResponse({
      responseId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res
        .status(404)
        .json({ success: false, message: "Vendor response not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Marked as read",
      data: result.response,
    });
  } catch (error) {
    console.error("Mark vendor response read error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating vendor response",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
