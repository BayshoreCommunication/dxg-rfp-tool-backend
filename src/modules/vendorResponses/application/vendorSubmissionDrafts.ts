import crypto from "node:crypto";
import type { VendorResponseQuestionnaireV1 } from "../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../contracts/generated/vendor-response-v1";
import type { VendorResponseWorkspaceV1 } from "../../../../contracts/generated/vendor-response-workspace-v1";
import { validateVendorResponseWorkspaceV1 } from "../../../../contracts/vendor-response/v1/validators";
import { safeFilename } from "../../documentIngestion/domain";
import { pseudonym, safeLog } from "../../../shared/observability/safeTelemetry";
import {
  createEmptyStructuredVendorResponse,
  toVendorDraftDocumentDto,
  toVendorSubmissionDraftDetailDto,
  toVendorSubmissionDraftDto,
  VENDOR_RESPONSE_DRAFT_RETENTION_DAYS_DEFAULT,
  VENDOR_RESPONSE_DRAFT_RETENTION_DAYS_MAXIMUM,
  vendorDraftExpiresAt,
  type VendorDraftDocument,
  type VendorDraftDocumentDto,
  type VendorDraftDocumentScopeType,
  type VendorSubmissionDraftDetailDto,
  type VendorSubmissionDraftRecord,
  type VendorSubmissionDraftScope,
} from "../domain/draft";
import type { VendorSubmissionDraftRepository } from "../domain/ports/vendorSubmissionDraftRepository";
import type {
  VendorDocumentStorage,
  VendorUploadMalwareScan,
} from "../domain/ports/vendorSubmissionPorts";
import {
  validateStructuredVendorResponse,
  validateVendorResponseQuestionnaire,
  type VendorResponseValidationIssue,
} from "../domain/structuredResponse";

export type VendorDraftUpload = {
  originalname: string;
  path: string;
  mimetype?: string;
  size?: number;
};

export class VendorSubmissionDraftError extends Error {
  constructor(
    public readonly code:
      | "DRAFT_NOT_FOUND"
      | "DRAFT_CONFLICT"
      | "DRAFT_EXPIRED"
      | "DRAFT_INACTIVE"
      | "DRAFT_RESPONSE_INVALID"
      | "REVISION_NOT_AUTHORIZED"
      | "DOCUMENT_CATEGORY_INVALID"
      | "DOCUMENT_SCOPE_INVALID"
      | "DOCUMENT_COUNT_INVALID"
      | "DOCUMENT_SIZE_INVALID"
      | "DOCUMENT_TYPE_INVALID"
      | "DOCUMENT_SCAN_FAILED"
      | "DOCUMENT_SCAN_UNAVAILABLE"
      | "DOCUMENT_UPLOAD_FAILED"
      | "DOCUMENT_NOT_FOUND"
      | "QUESTIONNAIRE_INVALID"
      | "WORKSPACE_INVALID",
    public readonly status: number,
    message: string,
    public readonly latestDraftRevision?: number,
    public readonly issues?: VendorResponseValidationIssue[],
  ) {
    super(message);
  }
}

const supportedExtensions: Record<string, readonly string[]> = {
  "application/pdf": ["pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
};

const validExtension = (name: string, mimeType: string): boolean => {
  const extension = name.split(".").pop()?.toLowerCase();
  return Boolean(
    extension
    && supportedExtensions[mimeType]?.includes(extension),
  );
};

const boundedRetentionDays = (value: number | undefined): number =>
  Number.isInteger(value) && Number(value) >= 1
    ? Math.min(Number(value), VENDOR_RESPONSE_DRAFT_RETENTION_DAYS_MAXIMUM)
    : VENDOR_RESPONSE_DRAFT_RETENTION_DAYS_DEFAULT;

const isExpired = (draft: VendorSubmissionDraftRecord, now: Date): boolean =>
  new Date(draft.expiresAt).getTime() <= now.getTime();

const documentReference = (
  documentId: string,
  purposeId: string,
  scopeType: VendorDraftDocumentScopeType,
  scopeId?: string,
): VendorResponseV1["documents"][number] => ({
  documentId,
  purposeId,
  scopeType,
  ...(scopeId ? { scopeId } : {}),
});

const cleanDocumentLinks = (
  response: VendorResponseV1,
  documentId: string,
): VendorResponseV1 => {
  const next = structuredClone(response);
  next.documents = next.documents.filter((entry) => entry.documentId !== documentId);
  next.crew = next.crew.map((member) => {
    if (member.headshotDocumentId !== documentId) return member;
    const withoutHeadshot = { ...member };
    delete withoutHeadshot.headshotDocumentId;
    return withoutHeadshot;
  });
  next.references = next.references.map((reference) => ({
    ...reference,
    visualDocumentIds: reference.visualDocumentIds.filter((id) => id !== documentId),
  }));
  return next;
};

const activeDocumentCount = (draft: VendorSubmissionDraftRecord): number =>
  draft.documents.filter((document) => document.status === "active").length;

const validDocumentScope = (
  response: VendorResponseV1,
  scopeType: VendorDraftDocumentScopeType,
  scopeId?: string,
): boolean => {
  if (scopeType === "proposal") return scopeId === undefined;
  if (!scopeId) return false;
  if (scopeType === "room") {
    return response.rooms.some((room) => room.roomId === scopeId);
  }
  if (scopeType === "crew_member") {
    return response.crew.some((member) => member.crewMemberId === scopeId);
  }
  return response.references.some((reference) => reference.referenceId === scopeId);
};

export const createVendorSubmissionDraftService = (dependencies: {
  repository: VendorSubmissionDraftRepository;
  storage: VendorDocumentStorage;
  malwareScan: VendorUploadMalwareScan;
  folderName: string;
  retentionDays?: number;
  now?: () => Date;
}) => {
  const now = dependencies.now ?? (() => new Date());
  const retentionDays = boundedRetentionDays(dependencies.retentionDays);
  const folder = dependencies.folderName.replace(/^\/+|\/+$/g, "") || "rfp-tool";

  const requireDraft = async (
    scope: VendorSubmissionDraftScope,
    draftId: string,
  ): Promise<VendorSubmissionDraftRecord> => {
    const draft = await dependencies.repository.findById(scope, draftId);
    if (!draft) {
      throw new VendorSubmissionDraftError(
        "DRAFT_NOT_FOUND",
        404,
        "Vendor response draft was not found",
      );
    }
    return draft;
  };

  const requireActive = (
    draft: VendorSubmissionDraftRecord,
    at: Date,
  ): void => {
    if (isExpired(draft, at)) {
      throw new VendorSubmissionDraftError(
        "DRAFT_EXPIRED",
        410,
        "Vendor response draft has expired",
        draft.draftRevision,
      );
    }
    if (draft.status !== "active") {
      throw new VendorSubmissionDraftError(
        "DRAFT_INACTIVE",
        409,
        "Vendor response draft is no longer active",
        draft.draftRevision,
      );
    }
  };

  const conflictFor = async (
    scope: VendorSubmissionDraftScope,
    draftId: string,
    at: Date,
  ): Promise<never> => {
    const latest = await requireDraft(scope, draftId);
    requireActive(latest, at);
    throw new VendorSubmissionDraftError(
      "DRAFT_CONFLICT",
      409,
      "The draft changed in another request. Reload the latest revision and try again.",
      latest.draftRevision,
    );
  };

  const update = async (
    scope: VendorSubmissionDraftScope,
    draft: VendorSubmissionDraftRecord,
    expectedRevision: number,
    response: VendorResponseV1,
    documents: VendorDraftDocument[],
    at: Date,
  ): Promise<VendorSubmissionDraftRecord> => {
    const updated = await dependencies.repository.updateActive({
      ...scope,
      draftId: draft.draftId,
      expectedRevision,
      response,
      documents,
      now: at,
      expiresAt: vendorDraftExpiresAt(at, retentionDays),
    });
    return updated ?? conflictFor(scope, draft.draftId, at);
  };

  const deleteStoredDocuments = async (
    documents: readonly Pick<VendorDraftDocument, "objectKey">[],
  ): Promise<void> => {
    const results = await Promise.allSettled(
      documents.map((document) => dependencies.storage.delete(document.objectKey)),
    );
    if (results.some((result) => result.status === "rejected")) {
      safeLog("warn", "vendor_draft_document_cleanup_pending", {
        errorCode: "DOCUMENT_DELETE_FAILED",
        documentCount: documents.length,
      });
    }
  };

  const cleanupDraft = async (
    draft: VendorSubmissionDraftRecord,
    at: Date,
  ): Promise<{ deleted: number; retained: number; failed: number }> => {
    let deleted = 0;
    let retained = 0;
    let failed = 0;
    for (const document of draft.documents) {
      if (document.objectDeletedAt) continue;
      if (
        await dependencies.repository.documentIsSubmitted(
          draft.organizationId,
          document.documentId,
        )
      ) {
        retained += 1;
        continue;
      }
      try {
        await dependencies.storage.delete(document.objectKey);
        await dependencies.repository.markDocumentDeleted(
          draft.draftId,
          document.documentId,
          at,
        );
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed === 0) {
      await dependencies.repository.markCleanupComplete(draft.draftId, at);
    }
    return { deleted, retained, failed };
  };

  return {
    async createOrResume(input: VendorSubmissionDraftScope & {
      questionnaire: VendorResponseQuestionnaireV1;
      submissionId?: string | null;
    }): Promise<{ draft: VendorSubmissionDraftDetailDto; created: boolean }> {
      const at = now();
      const questionnaireIssues = validateVendorResponseQuestionnaire(
        input.questionnaire,
      );
      if (
        input.questionnaire.proposalId !== input.proposalId
        || questionnaireIssues.length > 0
      ) {
        throw new VendorSubmissionDraftError(
          "QUESTIONNAIRE_INVALID",
          422,
          "Questionnaire cannot be used for this vendor draft",
          undefined,
          questionnaireIssues,
        );
      }
      if (input.submissionId) {
        const authorized = await dependencies.repository.revisionSubmissionIsAuthorized({
          ...input,
          submissionId: input.submissionId,
        });
        if (!authorized) {
          throw new VendorSubmissionDraftError(
            "REVISION_NOT_AUTHORIZED",
            404,
            "Submission was not found for this invitation",
          );
        }
      }
      const existing = await dependencies.repository.findActive(input, at);
      if (existing) {
        if ((existing.submissionId ?? null) !== (input.submissionId ?? null)) {
          throw new VendorSubmissionDraftError(
            "DRAFT_CONFLICT",
            409,
            "This invitation already has an active draft for a different submission context",
            existing.draftRevision,
          );
        }
        safeLog("info", "vendor_response_draft_ready", {
          organizationPseudonym: pseudonym(input.organizationId),
          proposalPseudonym: pseudonym(input.proposalId),
          draftPseudonym: pseudonym(existing.draftId),
          responseFormat: "structured_v1",
          outcome: "resumed",
        });
        return {
          draft: toVendorSubmissionDraftDetailDto(existing),
          created: false,
        };
      }
      const result = await dependencies.repository.createActive({
        ...input,
        submissionId: input.submissionId ?? null,
        response: createEmptyStructuredVendorResponse(input.questionnaire),
        now: at,
        expiresAt: vendorDraftExpiresAt(at, retentionDays),
      });
      if ((result.draft.submissionId ?? null) !== (input.submissionId ?? null)) {
        throw new VendorSubmissionDraftError(
          "DRAFT_CONFLICT",
          409,
          "This invitation already has an active draft for a different submission context",
          result.draft.draftRevision,
        );
      }
      safeLog("info", "vendor_response_draft_ready", {
        organizationPseudonym: pseudonym(input.organizationId),
        proposalPseudonym: pseudonym(input.proposalId),
        draftPseudonym: pseudonym(result.draft.draftId),
        responseFormat: "structured_v1",
        outcome: result.created ? "created" : "resumed",
      });
      return {
        draft: toVendorSubmissionDraftDetailDto(result.draft),
        created: result.created,
      };
    },

    async get(
      scope: VendorSubmissionDraftScope,
      draftId: string,
    ): Promise<VendorSubmissionDraftDetailDto> {
      const at = now();
      const draft = await requireDraft(scope, draftId);
      requireActive(draft, at);
      return toVendorSubmissionDraftDetailDto(draft);
    },

    async createOrResumeRevision(input: VendorSubmissionDraftScope & {
      submissionId: string;
    }): Promise<{ draft: VendorSubmissionDraftDetailDto; created: boolean }> {
      const at = now();
      const existing = await dependencies.repository.findActive(input, at);
      if (existing) {
        if (existing.submissionId !== input.submissionId) {
          throw new VendorSubmissionDraftError(
            "DRAFT_CONFLICT",
            409,
            "This invitation already has an active draft for a different submission context",
            existing.draftRevision,
          );
        }
        return {
          draft: toVendorSubmissionDraftDetailDto(existing),
          created: false,
        };
      }
      const seed = await dependencies.repository.loadRevisionSeed(input);
      if (
        !seed
        || validateVendorResponseQuestionnaire(seed.questionnaire).length > 0
        || validateStructuredVendorResponse(
          seed.questionnaire,
          seed.response,
          "draft",
        ).length > 0
      ) {
        throw new VendorSubmissionDraftError(
          "REVISION_NOT_AUTHORIZED",
          404,
          "Structured submission was not found for this invitation",
        );
      }
      const result = await dependencies.repository.createActive({
        ...input,
        questionnaire: structuredClone(seed.questionnaire),
        response: structuredClone(seed.response),
        documents: structuredClone(seed.documents),
        now: at,
        expiresAt: vendorDraftExpiresAt(at, retentionDays),
      });
      if (result.draft.submissionId !== input.submissionId) {
        throw new VendorSubmissionDraftError(
          "DRAFT_CONFLICT",
          409,
          "This invitation already has an active draft for a different submission context",
          result.draft.draftRevision,
        );
      }
      return {
        draft: toVendorSubmissionDraftDetailDto(result.draft),
        created: result.created,
      };
    },

    async save(input: VendorSubmissionDraftScope & {
      draftId: string;
      expectedRevision: number;
      response: unknown;
    }): Promise<VendorSubmissionDraftDetailDto> {
      const at = now();
      const draft = await requireDraft(input, input.draftId);
      requireActive(draft, at);
      const candidate = input.response && typeof input.response === "object"
        ? {
            ...(structuredClone(input.response) as Record<string, unknown>),
            documents: structuredClone(draft.response.documents),
          }
        : input.response;
      const issues = validateStructuredVendorResponse(
        draft.questionnaire,
        candidate,
        "draft",
      );
      if (issues.length > 0) {
        throw new VendorSubmissionDraftError(
          "DRAFT_RESPONSE_INVALID",
          422,
          "Draft response is invalid",
          draft.draftRevision,
          issues,
        );
      }
      const updated = await update(
        input,
        draft,
        input.expectedRevision,
        candidate as VendorResponseV1,
        draft.documents,
        at,
      );
      safeLog("info", "vendor_response_draft_saved", {
        organizationPseudonym: pseudonym(input.organizationId),
        proposalPseudonym: pseudonym(input.proposalId),
        draftPseudonym: pseudonym(updated.draftId),
        responseFormat: "structured_v1",
        roomCount: updated.response.rooms.length,
        documentCount: activeDocumentCount(updated),
        outcome: "success",
      });
      return toVendorSubmissionDraftDetailDto(updated);
    },

    async uploadDocuments(input: VendorSubmissionDraftScope & {
      draftId: string;
      expectedRevision: number;
      purposeId: string;
      scopeType: VendorDraftDocumentScopeType;
      scopeId?: string;
      files: VendorDraftUpload[];
    }): Promise<{
      draft: VendorSubmissionDraftDetailDto;
      documents: VendorDraftDocumentDto[];
    }> {
      const uploaded: VendorDraftDocument[] = [];
      const cleanupLocal = () => Promise.allSettled(
        input.files.map((file) => dependencies.storage.cleanup(file.path)),
      );
      try {
        const at = now();
        const draft = await requireDraft(input, input.draftId);
        requireActive(draft, at);
        const category = draft.questionnaire.documents.categories.find(
          (entry) => entry.purposeId === input.purposeId,
        );
        if (!category) {
          throw new VendorSubmissionDraftError(
            "DOCUMENT_CATEGORY_INVALID",
            422,
            "Document purpose is not part of this questionnaire",
          );
        }
        if (input.files.length === 0) {
          throw new VendorSubmissionDraftError(
            "DOCUMENT_COUNT_INVALID",
            422,
            "At least one document is required",
          );
        }
        if (!validDocumentScope(draft.response, input.scopeType, input.scopeId)) {
          throw new VendorSubmissionDraftError(
            "DOCUMENT_SCOPE_INVALID",
            422,
            "Document scope does not exist in this draft",
          );
        }
        const activeForCategory = draft.documents.filter(
          (document) => document.status === "active"
            && document.purposeId === input.purposeId,
        ).length;
        if (
          activeForCategory + input.files.length > category.maximumFiles
          || activeDocumentCount(draft) + input.files.length
            > draft.questionnaire.documents.globalMaximumFiles
        ) {
          throw new VendorSubmissionDraftError(
            "DOCUMENT_COUNT_INVALID",
            422,
            "Document count exceeds the questionnaire limit",
          );
        }

        const declaredMimeTypes = input.files.map(
          (file) => file.mimetype?.trim().toLowerCase() ?? "",
        );
        for (const [index, file] of input.files.entries()) {
          const declaredMimeType = declaredMimeTypes[index];
          if (
            !category.allowedMimeTypes.includes(declaredMimeType)
            || !validExtension(file.originalname, declaredMimeType)
          ) {
            throw new VendorSubmissionDraftError(
              "DOCUMENT_TYPE_INVALID",
              415,
              "Document type is not allowed for this category",
            );
          }
        }

        const inspected = [];
        for (const [index, file] of input.files.entries()) {
          const result = await dependencies.storage.inspect(
            file.path,
            declaredMimeTypes[index],
          );
          if (result.sizeBytes < 1 || result.sizeBytes > category.maximumFileBytes) {
            throw new VendorSubmissionDraftError(
              "DOCUMENT_SIZE_INVALID",
              413,
              "Document size exceeds the questionnaire limit",
            );
          }
          if (result.detectedMimeType !== declaredMimeTypes[index]) {
            throw new VendorSubmissionDraftError(
              "DOCUMENT_TYPE_INVALID",
              415,
              "Document content does not match its declared type",
            );
          }
          inspected.push(result);
        }

        const scanOutcomes: Array<"clean" | "skipped"> = [];
        for (const file of input.files) {
          const outcome = await dependencies.malwareScan(file.path);
          if (outcome === "infected") {
            throw new VendorSubmissionDraftError(
              "DOCUMENT_SCAN_FAILED",
              422,
              "A document failed the malware scan",
            );
          }
          if (outcome === "unavailable") {
            throw new VendorSubmissionDraftError(
              "DOCUMENT_SCAN_UNAVAILABLE",
              503,
              "Documents cannot be scanned right now",
            );
          }
          scanOutcomes.push(outcome);
        }

        for (const [index, file] of input.files.entries()) {
          const documentId = crypto.randomUUID();
          const sourceId = crypto.randomUUID();
          const displayName = safeFilename(file.originalname);
          const objectKey = `${folder}/vendor-response-drafts-private/${input.proposalId}/${input.draftId}/${sourceId}-${displayName.replace(/\s+/g, "_")}`;
          const url = await dependencies.storage.upload({
            localPath: file.path,
            objectKey,
          });
          uploaded.push({
            documentId,
            sourceId,
            purposeId: input.purposeId,
            scopeType: input.scopeType,
            ...(input.scopeId ? { scopeId: input.scopeId } : {}),
            name: displayName,
            url,
            objectKey,
            mimeType: declaredMimeTypes[index],
            sizeBytes: inspected[index].sizeBytes,
            sha256: inspected[index].sha256,
            scanStatus: scanOutcomes[index],
            status: "active",
            uploadedAt: at.toISOString(),
            retiredAt: null,
            objectDeletedAt: null,
          });
        }

        const response = structuredClone(draft.response);
        response.documents.push(
          ...uploaded.map((document) => documentReference(
            document.documentId,
            document.purposeId,
            document.scopeType,
            document.scopeId,
          )),
        );
        const issues = validateStructuredVendorResponse(
          draft.questionnaire,
          response,
          "draft",
        );
        if (issues.length > 0) {
          throw new VendorSubmissionDraftError(
            "DOCUMENT_SCOPE_INVALID",
            422,
            "Document scope is not valid for this draft",
            draft.draftRevision,
            issues,
          );
        }
        const updated = await update(
          input,
          draft,
          input.expectedRevision,
          response,
          [...draft.documents, ...uploaded],
          at,
        );
        return {
          draft: toVendorSubmissionDraftDetailDto(updated),
          documents: uploaded.map(toVendorDraftDocumentDto),
        };
      } catch (error) {
        await deleteStoredDocuments(uploaded);
        if (error instanceof VendorSubmissionDraftError) throw error;
        throw new VendorSubmissionDraftError(
          "DOCUMENT_UPLOAD_FAILED",
          503,
          "Document upload could not be completed",
        );
      } finally {
        await cleanupLocal();
      }
    },

    async retireDocument(input: VendorSubmissionDraftScope & {
      draftId: string;
      documentId: string;
      expectedRevision: number;
    }): Promise<VendorSubmissionDraftDetailDto> {
      const at = now();
      const draft = await requireDraft(input, input.draftId);
      requireActive(draft, at);
      const existing = draft.documents.find(
        (document) => document.documentId === input.documentId
          && document.status === "active",
      );
      if (!existing) {
        throw new VendorSubmissionDraftError(
          "DOCUMENT_NOT_FOUND",
          404,
          "Draft document was not found",
        );
      }
      const documents = draft.documents.map((document) =>
        document.documentId === input.documentId
          ? { ...document, status: "retired" as const, retiredAt: at.toISOString() }
          : document);
      const response = cleanDocumentLinks(draft.response, input.documentId);
      const updated = await update(
        input,
        draft,
        input.expectedRevision,
        response,
        documents,
        at,
      );
      if (
        !await dependencies.repository.documentIsSubmitted(
          draft.organizationId,
          existing.documentId,
        )
      ) {
        try {
          await dependencies.storage.delete(existing.objectKey);
          await dependencies.repository.markDocumentDeleted(
            draft.draftId,
            existing.documentId,
            at,
          );
        } catch {
          safeLog("warn", "vendor_draft_document_retirement_pending", {
            errorCode: "DOCUMENT_DELETE_FAILED",
            documentCount: 1,
          });
        }
      }
      return toVendorSubmissionDraftDetailDto(updated);
    },

    async abandon(input: VendorSubmissionDraftScope & {
      draftId: string;
      expectedRevision: number;
    }): Promise<VendorSubmissionDraftDetailDto> {
      const at = now();
      const draft = await requireDraft(input, input.draftId);
      requireActive(draft, at);
      const abandoned = await dependencies.repository.abandon({
        ...input,
        now: at,
      });
      if (!abandoned) return conflictFor(input, input.draftId, at);
      await cleanupDraft(abandoned, at);
      return toVendorSubmissionDraftDetailDto(abandoned);
    },

    async hydrateWorkspace(
      workspace: VendorResponseWorkspaceV1,
      scope: VendorSubmissionDraftScope,
    ): Promise<VendorResponseWorkspaceV1> {
      const [draft, currentSubmission] = await Promise.all([
        dependencies.repository.findActive(scope, now()),
        dependencies.repository.findCurrentSubmission(scope),
      ]);
      if (!draft && !currentSubmission) return workspace;
      const hydrated: VendorResponseWorkspaceV1 = {
        ...workspace,
        ...(draft ? {
          questionnaire: draft.questionnaire,
          draft: toVendorSubmissionDraftDto(draft),
        } : {}),
        currentSubmission,
      };
      if (!validateVendorResponseWorkspaceV1(hydrated)) {
        throw new VendorSubmissionDraftError(
          "WORKSPACE_INVALID",
          500,
          "Vendor response workspace could not be created",
        );
      }
      return hydrated;
    },

    async cleanupExpired(limit = 50): Promise<{
      drafts: number;
      deletedDocuments: number;
      retainedDocuments: number;
      failedDocuments: number;
    }> {
      const at = now();
      const boundedLimit = Number.isInteger(limit)
        ? Math.min(Math.max(limit, 1), 100)
        : 50;
      const drafts = await dependencies.repository.listCleanupCandidates(
        at,
        boundedLimit,
      );
      let deletedDocuments = 0;
      let retainedDocuments = 0;
      let failedDocuments = 0;
      for (const draft of drafts) {
        if (draft.status === "active") {
          const abandoned = await dependencies.repository.markExpiredAbandoned(
            draft.draftId,
            at,
          );
          if (!abandoned) continue;
        }
        const result = await cleanupDraft(draft, at);
        deletedDocuments += result.deleted;
        retainedDocuments += result.retained;
        failedDocuments += result.failed;
      }
      return {
        drafts: drafts.length,
        deletedDocuments,
        retainedDocuments,
        failedDocuments,
      };
    },
  };
};
