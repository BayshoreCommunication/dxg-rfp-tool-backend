import crypto from "node:crypto";
import type { VendorSubmissionVersionReason } from "../../../../modal/vendorSubmissionVersionModel";
import { safeLog } from "../../../shared/observability/safeTelemetry";
import type {
  VendorSubmissionRepository,
  VendorDocument,
  VendorSubmissionSourceRegistry,
  VendorSubmissionVersionRecord,
} from "../domain/ports/vendorSubmissionRepository";
import type {
  VendorConfirmationSender,
  VendorDocumentStorage,
  VendorResponseNotifier,
  VendorUploadMalwareScan,
} from "../domain/ports/vendorSubmissionPorts";

export type VendorUpload = {
  originalname: string;
  path: string;
  mimetype?: string;
  size?: number;
};

const required = (
  value: unknown,
  field: "vendorName" | "submittedBy" | "email",
) =>
  typeof value === "string" && value.trim()
    ? null
    : ({ kind: "invalid" as const, field });

const allowedRevisionReasons = new Set<VendorSubmissionVersionReason>([
  "vendor_revision",
  "clarification_response",
  "bafo",
  "administrative_correction",
]);

const fallbackIdempotencyKey = (input: {
  proposalId: string;
  email: string;
  trackingId: string | null;
  vendorName: string;
  message: string;
  files: VendorUpload[];
}) =>
  `legacy:${crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        proposalId: input.proposalId,
        email: input.email,
        trackingId: input.trackingId,
        vendorName: input.vendorName,
        message: input.message,
        files: input.files.map((file) => ({
          name: file.originalname,
          size: file.size ?? null,
        })),
      }),
    )
    .digest("hex")}`;

const reconcileSources = async (
  registry: VendorSubmissionSourceRegistry | undefined,
  record: VendorSubmissionVersionRecord,
) => {
  if (!registry) return { registered: 0, pending: record.documents.length };
  try {
    return await registry.register(record);
  } catch {
    safeLog("warn", "vendor_submission_source_registration_pending", {
      organizationId: record.organizationId,
      proposalId: record.proposalId,
      submissionId: record.submissionId,
      versionId: record.versionId,
      errorCode: "SOURCE_REGISTRY_UNAVAILABLE",
    });
    return { registered: 0, pending: record.documents.length };
  }
};

export const createCheckVendorResponse = (
  repository: VendorSubmissionRepository,
) => async (input: {
  proposalId?: string;
  email?: string;
  trackingId?: string;
}) => {
  const trackingId = input.trackingId?.trim();
  const existing = trackingId
    ? await repository.findByTrackingId(trackingId)
    : input.proposalId && input.email?.trim()
      ? await repository.findByProposalAndEmail({
          proposalId: input.proposalId,
          email: input.email.trim().toLowerCase(),
        })
      : null;
  return {
    alreadySubmitted: Boolean(existing),
    canSubmitRevision: Boolean(existing),
    currentVersionNumber: Number(existing?.currentVersionNumber ?? 0),
    latestVersionId: existing?.currentVersionId
      ? String(existing.currentVersionId)
      : null,
    submissionId: existing?.submissionId ? String(existing.submissionId) : null,
    existingResponse: existing,
  };
};

export const createGetVendorSubmissionReceipt = (
  repository: VendorSubmissionRepository,
) => (input: { proposalId: string; versionId: string; email: string }) =>
  repository.getReceipt(input);

export const createSubmitVendorResponse = (dependencies: {
  repository: VendorSubmissionRepository;
  storage: VendorDocumentStorage;
  notifier: VendorResponseNotifier;
  confirmation: VendorConfirmationSender;
  sourceRegistry?: VendorSubmissionSourceRegistry;
  folderName: string;
  now?: () => number;
  malwareScan?: VendorUploadMalwareScan;
}) => async (input: {
  proposalId: string;
  vendorName: unknown;
  submittedBy: unknown;
  email: unknown;
  message?: unknown;
  trackingId?: unknown;
  idempotencyKey?: unknown;
  reason?: unknown;
  files: VendorUpload[];
}) => {
  for (const [value, field] of [
    [input.vendorName, "vendorName"],
    [input.submittedBy, "submittedBy"],
    [input.email, "email"],
  ] as const) {
    const error = required(value, field);
    if (error) return error;
  }
  const vendorName = (input.vendorName as string).trim();
  const submittedBy = (input.submittedBy as string).trim();
  const email = (input.email as string).trim().toLowerCase();
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const trackingId =
    typeof input.trackingId === "string" && input.trackingId.trim()
      ? input.trackingId.trim()
      : null;
  const suppliedKey =
    typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  const idempotencyKey = suppliedKey
    ? `vendor_submission:${suppliedKey.slice(0, 180)}`
    : fallbackIdempotencyKey({
        proposalId: input.proposalId,
        email,
        trackingId,
        vendorName,
        message,
        files: input.files,
      });
  const folder = dependencies.folderName.replace(/^\/+|\/+$/g, "") || "rfp-tool";

  const proposal = await dependencies.repository.findProposal(input.proposalId);
  if (!proposal) {
    await Promise.all(input.files.map((file) => dependencies.storage.cleanup(file.path)));
    return { kind: "proposal_not_found" as const };
  }

  const replay = await dependencies.repository.findVersionByIdempotencyKey({
    organizationId: proposal.organizationId,
    idempotencyKey,
  });
  if (replay) {
    await Promise.all(input.files.map((file) => dependencies.storage.cleanup(file.path)));
    const sourceRegistration = await reconcileSources(dependencies.sourceRegistry, replay);
    return {
      kind: "duplicate" as const,
      response: replay.response,
      submission: replay,
      sourceRegistration,
    };
  }

  const existingResponse = await dependencies.repository.findExisting({
    proposalId: input.proposalId,
    email,
    trackingId,
  });

  const scanOutcomes = new Map<string, "clean" | "skipped">();
  if (dependencies.malwareScan) {
    for (const file of input.files) {
      const outcome = await dependencies.malwareScan(file.path);
      if (outcome === "infected" || outcome === "unavailable") {
        await Promise.all(
          input.files.map((pending) => dependencies.storage.cleanup(pending.path)),
        );
        return outcome === "infected"
          ? { kind: "infected" as const, fileName: file.originalname }
          : { kind: "scan_unavailable" as const };
      }
      scanOutcomes.set(file.path, outcome);
    }
  }

  const documents: VendorDocument[] = [];
  for (const [index, file] of input.files.entries()) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const documentId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const objectKey = `${folder}/vendor-responses-private/${input.proposalId}/sources/${sourceId}-${index}-${safeName}`;
    try {
      const inspected = await dependencies.storage.inspect(file.path);
      const url = await dependencies.storage.upload({
        localPath: file.path,
        objectKey,
      });
      documents.push({
        documentId,
        sourceId,
        name: file.originalname,
        url,
        objectKey,
        mimeType: file.mimetype || "application/octet-stream",
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
        scanStatus: scanOutcomes.get(file.path) ?? "skipped",
      });
    } catch {
      await dependencies.storage.cleanup(file.path);
    }
  }

  const requestedReason =
    typeof input.reason === "string" &&
    allowedRevisionReasons.has(input.reason as VendorSubmissionVersionReason)
      ? (input.reason as VendorSubmissionVersionReason)
      : "vendor_revision";
  const saved = await dependencies.repository.saveVersion({
    ...proposal,
    existingResponse,
    vendorName,
    submittedBy,
    email,
    message,
    newDocuments: documents,
    trackingId,
    idempotencyKey,
    reason: existingResponse ? requestedReason : "initial",
    sourceSystem: "public_portal",
    receivedAt: new Date((dependencies.now ?? Date.now)()),
  });
  const sourceRegistration = await reconcileSources(
    dependencies.sourceRegistry,
    saved.record,
  );

  if (saved.created && saved.record.versionNumber === 1) {
    await dependencies.notifier.notifyPlanner({
      ...proposal,
      responseId: String(saved.record.response._id),
      vendorName,
      submittedBy,
      email,
    });
  }
  if (saved.created) {
    void dependencies.confirmation.send({
      email,
      vendorName,
      submittedBy,
      proposalTitle: proposal.proposalTitle,
      isUpdate: saved.record.versionNumber > 1,
    });
  }

  return {
    kind: saved.created
      ? saved.record.versionNumber === 1
        ? ("created" as const)
        : ("version_created" as const)
      : ("duplicate" as const),
    response: saved.record.response,
    submission: saved.record,
    sourceRegistration,
  };
};
