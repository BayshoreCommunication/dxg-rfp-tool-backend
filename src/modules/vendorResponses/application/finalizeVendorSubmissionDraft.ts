import crypto from "node:crypto";
import { validateVendorResponseCalculationV1 } from "../../../../contracts/vendor-response/v1/validators";
import type {
  VendorDraftDocument,
  VendorSubmissionDraftRecord,
  VendorSubmissionDraftScope,
} from "../domain/draft";
import type { VendorSubmissionDraftRepository } from "../domain/ports/vendorSubmissionDraftRepository";
import type {
  VendorDocument,
  VendorSubmissionReceipt,
  VendorSubmissionRepository,
  VendorSubmissionSourceRegistry,
  VendorSubmissionVersionRecord,
} from "../domain/ports/vendorSubmissionRepository";
import type {
  VendorConfirmationSender,
  VendorResponseNotifier,
} from "../domain/ports/vendorSubmissionPorts";
import {
  calculateStructuredVendorResponse,
  validateStructuredVendorResponse,
  type VendorResponseValidationIssue,
} from "../domain/structuredResponse";
import { reconcileVendorSubmissionSources } from "./submitVendorResponse";

export class VendorSubmissionFinalizationError extends Error {
  constructor(
    public readonly code:
      | "DRAFT_NOT_FOUND"
      | "DRAFT_CONFLICT"
      | "DRAFT_EXPIRED"
      | "DRAFT_INACTIVE"
      | "DRAFT_FINAL_INVALID"
      | "DRAFT_DOCUMENT_MISMATCH"
      | "FINALIZATION_IN_PROGRESS"
      | "IDEMPOTENCY_KEY_REUSED"
      | "FINALIZATION_FAILED",
    public readonly status: number,
    message: string,
    public readonly latestDraftRevision?: number,
    public readonly issues?: VendorResponseValidationIssue[],
  ) {
    super(message);
  }
}

const receiptFrom = (
  record: VendorSubmissionVersionRecord,
): VendorSubmissionReceipt => ({
  submissionId: record.submissionId,
  versionId: record.versionId,
  versionNumber: record.versionNumber,
  parentVersionId: record.parentVersionId,
  reason: record.reason,
  receivedAt: record.receivedAt,
  manifestChecksum: record.manifestChecksum,
  proposalId: record.proposalId,
  proposalTitle: record.proposalTitle,
  vendorName: record.vendorName,
  submittedBy: record.submittedBy,
  email: record.email,
  message: record.message,
  documents: record.documents.map((document) => ({
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
    versionDisposition: document.versionDisposition,
  })),
  retiredDocuments: record.retiredDocuments,
  responseSchemaVersion: record.responseSchemaVersion,
  questionnaire: record.questionnaire,
  calculationSnapshot: record.calculationSnapshot,
  finalizedDraftId: record.finalizedDraftId,
});

const activeDocuments = (draft: VendorSubmissionDraftRecord) =>
  draft.documents.filter((document) => document.status === "active");

const documentMismatchIssues = (
  draft: VendorSubmissionDraftRecord,
): VendorResponseValidationIssue[] => {
  const documents = activeDocuments(draft);
  const byId = new Map(documents.map((document) => [document.documentId, document]));
  const issues: VendorResponseValidationIssue[] = [];
  const referencedIds = new Set<string>();
  for (const reference of draft.response.documents) {
    if (referencedIds.has(reference.documentId)) {
      issues.push({
        code: "duplicate_document",
        path: "/documents",
        sectionId: "documents",
        message: `Document is referenced more than once: ${reference.documentId}`,
      });
      continue;
    }
    referencedIds.add(reference.documentId);
    const document = byId.get(reference.documentId);
    if (
      !document
      || document.objectDeletedAt
      || document.purposeId !== reference.purposeId
      || document.scopeType !== reference.scopeType
      || (document.scopeId ?? null) !== (reference.scopeId ?? null)
    ) {
      issues.push({
        code: "document_manifest_mismatch",
        path: `/documents/${reference.documentId}`,
        sectionId: "documents",
        message: "Document reference does not match the active draft manifest",
      });
    }
  }
  for (const document of documents) {
    if (!referencedIds.has(document.documentId)) {
      issues.push({
        code: "document_manifest_mismatch",
        path: `/documents/${document.documentId}`,
        sectionId: "documents",
        message: "Active draft document is missing from the response",
      });
    }
  }
  return issues;
};

const versionDocument = (document: VendorDraftDocument): VendorDocument => ({
  documentId: document.documentId,
  sourceId: document.sourceId,
  name: document.name,
  url: document.url,
  objectKey: document.objectKey,
  mimeType: document.mimeType,
  sizeBytes: document.sizeBytes,
  sha256: document.sha256,
  scanStatus: document.scanStatus,
  purposeId: document.purposeId,
  scopeType: document.scopeType,
  scopeId: document.scopeId ?? null,
  versionDisposition: document.inheritedFromVersionId ? "inherited" : "added",
  inheritedFromVersionId: document.inheritedFromVersionId ?? null,
});

const keyFor = (supplied: unknown, draftId: string, draftRevision: number) => {
  const raw = typeof supplied === "string" && supplied.trim()
    ? supplied.trim().slice(0, 180)
    : `draft:${draftId}:${draftRevision}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return {
    hash,
    idempotencyKey: `vendor_draft_finalize:${hash}`,
  };
};

const failForDraftState = (
  draft: VendorSubmissionDraftRecord,
  at: Date,
): never => {
  if (new Date(draft.expiresAt).getTime() <= at.getTime()) {
    throw new VendorSubmissionFinalizationError(
      "DRAFT_EXPIRED",
      410,
      "Vendor response draft has expired",
      draft.draftRevision,
    );
  }
  throw new VendorSubmissionFinalizationError(
    "DRAFT_INACTIVE",
    409,
    "Vendor response draft is no longer active",
    draft.draftRevision,
  );
};

export const createFinalizeVendorSubmissionDraft = (dependencies: {
  draftRepository: VendorSubmissionDraftRepository;
  submissionRepository: VendorSubmissionRepository;
  notifier: VendorResponseNotifier;
  confirmation: VendorConfirmationSender;
  sourceRegistry?: VendorSubmissionSourceRegistry;
  now?: () => Date;
}) => async (input: VendorSubmissionDraftScope & {
  draftId: string;
  expectedRevision: number;
  idempotencyKey?: unknown;
}) => {
  const at = (dependencies.now ?? (() => new Date()))();
  const key = keyFor(input.idempotencyKey, input.draftId, input.expectedRevision);
  let draft = await dependencies.draftRepository.findById(input, input.draftId);
  if (!draft) {
    throw new VendorSubmissionFinalizationError(
      "DRAFT_NOT_FOUND",
      404,
      "Vendor response draft was not found",
    );
  }

  const alreadyFinalized = async () => {
    const replay = await dependencies.submissionRepository.findVersionByFinalizedDraft({
      organizationId: input.organizationId,
      draftId: input.draftId,
    });
    if (!replay) return null;
    if (draft?.status === "active") {
      await dependencies.draftRepository.completeFinalization({
        ...input,
        finalizationKeyHash: draft.finalizationKeyHash ?? key.hash,
        submittedVersionId: replay.versionId,
        now: at,
      });
    }
    return {
      kind: "duplicate" as const,
      receipt: receiptFrom(replay),
      sourceRegistration: await reconcileVendorSubmissionSources(
        dependencies.sourceRegistry,
        replay,
      ),
    };
  };

  if (draft.status === "submitted") {
    const replay = await alreadyFinalized();
    if (replay) return replay;
    throw new VendorSubmissionFinalizationError(
      "FINALIZATION_FAILED",
      503,
      "The original submission receipt is temporarily unavailable",
      draft.draftRevision,
    );
  }
  if (draft.status !== "active" || new Date(draft.expiresAt).getTime() <= at.getTime()) {
    failForDraftState(draft, at);
  }
  if (draft.draftRevision !== input.expectedRevision) {
    throw new VendorSubmissionFinalizationError(
      "DRAFT_CONFLICT",
      409,
      "The draft changed in another request. Reload the latest revision and try again.",
      draft.draftRevision,
    );
  }

  const responseSnapshot = structuredClone(draft.response);
  responseSnapshot.acknowledgements = responseSnapshot.acknowledgements.map(
    (acknowledgement) => {
      if (acknowledgement.accepted) {
        return { ...acknowledgement, acceptedAt: at.toISOString() };
      }
      const next = { ...acknowledgement };
      delete next.acceptedAt;
      return next;
    },
  );
  const validationIssues = validateStructuredVendorResponse(
    draft.questionnaire,
    responseSnapshot,
    "final",
  );
  if (validationIssues.length > 0) {
    throw new VendorSubmissionFinalizationError(
      "DRAFT_FINAL_INVALID",
      422,
      "Vendor response is incomplete or invalid",
      draft.draftRevision,
      validationIssues,
    );
  }
  const manifestIssues = documentMismatchIssues(draft);
  if (manifestIssues.length > 0) {
    throw new VendorSubmissionFinalizationError(
      "DRAFT_DOCUMENT_MISMATCH",
      422,
      "Vendor response documents do not match the draft manifest",
      draft.draftRevision,
      manifestIssues,
    );
  }

  const calculation = calculateStructuredVendorResponse(
    draft.questionnaire,
    responseSnapshot,
    at.toISOString(),
  );
  if (!validateVendorResponseCalculationV1(calculation)) {
    throw new VendorSubmissionFinalizationError(
      "FINALIZATION_FAILED",
      500,
      "Vendor response calculation could not be frozen",
      draft.draftRevision,
    );
  }

  const idempotencyReplay =
    await dependencies.submissionRepository.findVersionByIdempotencyKey({
      organizationId: input.organizationId,
      idempotencyKey: key.idempotencyKey,
    });
  if (idempotencyReplay) {
    if (idempotencyReplay.finalizedDraftId !== input.draftId) {
      throw new VendorSubmissionFinalizationError(
        "IDEMPOTENCY_KEY_REUSED",
        409,
        "Submission idempotency key was already used for another draft",
        draft.draftRevision,
      );
    }
    const replay = await alreadyFinalized();
    if (replay) return replay;
  }

  const claimed = await dependencies.draftRepository.claimFinalization({
    ...input,
    finalizationKeyHash: key.hash,
    now: at,
  });
  if (!claimed) {
    draft = await dependencies.draftRepository.findById(input, input.draftId);
    if (draft) {
      const replay = await alreadyFinalized();
      if (replay) return replay;
      if (draft.finalizationKeyHash && draft.finalizationKeyHash !== key.hash) {
        throw new VendorSubmissionFinalizationError(
          "FINALIZATION_IN_PROGRESS",
          409,
          "Vendor response finalization is already in progress",
          draft.draftRevision,
        );
      }
      if (draft.draftRevision !== input.expectedRevision) {
        throw new VendorSubmissionFinalizationError(
          "DRAFT_CONFLICT",
          409,
          "The draft changed in another request. Reload the latest revision and try again.",
          draft.draftRevision,
        );
      }
      failForDraftState(draft, at);
    }
    throw new VendorSubmissionFinalizationError(
      "DRAFT_NOT_FOUND",
      404,
      "Vendor response draft was not found",
    );
  }
  draft = claimed;

  let versionPersisted = false;
  try {
    const proposal = await dependencies.submissionRepository.findProposal(
      draft.proposalId,
    );
    if (!proposal || proposal.organizationId !== draft.organizationId) {
      throw new VendorSubmissionFinalizationError(
        "DRAFT_NOT_FOUND",
        404,
        "Proposal was not found for this draft",
      );
    }
    const identity = responseSnapshot.identity;
    const existingResponse = draft.submissionId
      ? null
      : await dependencies.submissionRepository.findExisting({
          proposalId: draft.proposalId,
          email: identity.email.trim().toLowerCase(),
          trackingId: null,
        });
    const saved = await dependencies.submissionRepository.saveVersion({
      ...proposal,
      existingResponse,
      submissionId: draft.submissionId ?? null,
      vendorName: identity.vendorName.trim(),
      submittedBy: identity.submittedBy.trim(),
      email: identity.email.trim().toLowerCase(),
      message: responseSnapshot.valueAdds.trim(),
      newDocuments: activeDocuments(draft).map(versionDocument),
      trackingId: null,
      publicGrantId: draft.grantId,
      idempotencyKey: key.idempotencyKey,
      reason: draft.submissionId ? "vendor_revision" : "initial",
      sourceSystem: "public_portal",
      receivedAt: at,
      structured: {
        finalizedDraftId: draft.draftId,
        questionnaire: structuredClone(draft.questionnaire),
        response: structuredClone(responseSnapshot),
        calculation: structuredClone(calculation),
        retiredDocuments: draft.documents.flatMap((document) =>
          document.status === "retired" && document.inheritedFromVersionId
            ? [{
                documentId: document.documentId,
                retiredFromVersionId: document.inheritedFromVersionId,
              }]
            : []),
      },
    });
    versionPersisted = true;
    const completed = await dependencies.draftRepository.completeFinalization({
      ...input,
      finalizationKeyHash: key.hash,
      submittedVersionId: saved.record.versionId,
      now: at,
    });
    if (!completed) {
      const replay = await dependencies.submissionRepository.findVersionByFinalizedDraft({
        organizationId: input.organizationId,
        draftId: input.draftId,
      });
      if (replay) {
        return {
          kind: "duplicate" as const,
          receipt: receiptFrom(replay),
          sourceRegistration: await reconcileVendorSubmissionSources(
            dependencies.sourceRegistry,
            replay,
          ),
        };
      }
      throw new VendorSubmissionFinalizationError(
        "FINALIZATION_FAILED",
        503,
        "Submission was stored but the draft receipt is still being finalized",
        draft.draftRevision,
      );
    }

    const sourceRegistration = await reconcileVendorSubmissionSources(
      dependencies.sourceRegistry,
      saved.record,
    );
    if (saved.created && saved.record.versionNumber === 1) {
      await dependencies.notifier.notifyPlanner({
        ...proposal,
        responseId: String(saved.record.response._id),
        vendorName: saved.record.vendorName,
        submittedBy: saved.record.submittedBy,
        email: saved.record.email,
      });
    }
    if (saved.created) {
      void dependencies.confirmation.send({
        email: saved.record.email,
        vendorName: saved.record.vendorName,
        submittedBy: saved.record.submittedBy,
        proposalTitle: saved.record.proposalTitle,
        isUpdate: saved.record.versionNumber > 1,
      });
    }
    return {
      kind: saved.created ? ("created" as const) : ("duplicate" as const),
      receipt: receiptFrom(saved.record),
      sourceRegistration,
    };
  } catch (error) {
    if (!versionPersisted) {
      await dependencies.draftRepository.releaseFinalization({
        ...input,
        finalizationKeyHash: key.hash,
      });
    }
    if (error instanceof VendorSubmissionFinalizationError) throw error;
    if (
      error instanceof Error
      && error.message === "Submission idempotency key is already in use"
    ) {
      throw new VendorSubmissionFinalizationError(
        "IDEMPOTENCY_KEY_REUSED",
        409,
        "Submission idempotency key was already used for another draft",
        draft.draftRevision,
      );
    }
    throw new VendorSubmissionFinalizationError(
      "FINALIZATION_FAILED",
      503,
      "Vendor response could not be finalized. Please retry with the same idempotency key.",
      draft.draftRevision,
    );
  }
};
