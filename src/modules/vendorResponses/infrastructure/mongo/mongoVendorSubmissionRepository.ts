/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import mongoose from "mongoose";
import Proposal from "../../../../../modal/proposalsModel";
import VendorResponse from "../../../../../modal/vendorResponseModel";
import VendorSubmission from "../../../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../../../modal/vendorSubmissionVersionModel";
import { spacesObjectKeyFromUrl } from "../../../../../utils/uploadToSpaces";
import type {
  VendorDocument,
  VendorResponseRecord,
  VendorSubmissionRepository,
  VendorSubmissionVersionRecord,
} from "../../domain/ports/vendorSubmissionRepository";

const PUBLIC_RESPONSE_SELECT =
  "_id vendorName submittedBy email message documents proposalTitle createdAt updatedAt submissionId currentVersionId currentVersionNumber versionReason versionReceivedAt manifestChecksum";

const identityKey = (vendorName: string, email: string) =>
  crypto
    .createHash("sha256")
    .update(`${vendorName.trim().toLowerCase().replace(/\s+/g, " ")}|${email.trim().toLowerCase()}`)
    .digest("hex");

const checksum = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const vendorSubmissionManifestChecksum = (input: {
  proposalId: string;
  submissionId: string;
  versionNumber: number;
  reason: string;
  vendorName: string;
  submittedBy: string;
  email: string;
  message: string;
  documents: VendorDocument[];
}) =>
  checksum({
    proposalId: input.proposalId,
    submissionId: input.submissionId,
    versionNumber: input.versionNumber,
    reason: input.reason,
    vendorName: input.vendorName,
    submittedBy: input.submittedBy,
    email: input.email,
    message: input.message,
    documents: input.documents.map((document) => ({
      documentId: document.documentId,
      sourceId: document.sourceId,
      name: document.name,
      objectKey: document.objectKey,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      sha256: document.sha256,
      scanStatus: document.scanStatus,
      inheritedFromVersionId: document.inheritedFromVersionId ?? null,
    })),
  });

const documentRecord = (
  value: unknown,
  inheritedFromVersionId?: string | null,
): VendorDocument | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const url = String(record.url ?? "").trim();
  if (!url) return null;
  return {
    documentId:
      typeof record.documentId === "string" && record.documentId
        ? record.documentId
        : crypto.randomUUID(),
    sourceId:
      typeof record.sourceId === "string" && record.sourceId
        ? record.sourceId
        : crypto.randomUUID(),
    name: String(record.name ?? "Vendor document").slice(0, 255),
    url,
    objectKey:
      typeof record.objectKey === "string" && record.objectKey
        ? record.objectKey
        : spacesObjectKeyFromUrl(url) ?? `legacy/${checksum(url)}`,
    mimeType:
      typeof record.mimeType === "string" && record.mimeType
        ? record.mimeType
        : "application/octet-stream",
    sizeBytes:
      typeof record.sizeBytes === "number" && record.sizeBytes >= 0
        ? record.sizeBytes
        : null,
    sha256:
      typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256)
        ? record.sha256
        : null,
    scanStatus:
      record.scanStatus === "clean" || record.scanStatus === "skipped"
        ? record.scanStatus
        : "legacy_unknown",
    inheritedFromVersionId:
      inheritedFromVersionId ??
      (typeof record.inheritedFromVersionId === "string"
        ? record.inheritedFromVersionId
        : null),
  };
};

const documentRecords = (value: unknown, inheritedFromVersionId?: string | null) =>
  (Array.isArray(value) ? value : []).flatMap((document) => {
    const mapped = documentRecord(document, inheritedFromVersionId);
    return mapped ? [mapped] : [];
  });

const responseRecord = async (responseId: string): Promise<VendorResponseRecord> => {
  const row = await VendorResponse.findById(responseId)
    .select(PUBLIC_RESPONSE_SELECT)
    .lean<any>();
  if (!row) throw new Error("Vendor response disappeared during version projection");
  return row;
};

const toVersionRecord = (
  version: any,
  submission: any,
  response: VendorResponseRecord,
): VendorSubmissionVersionRecord => ({
  submissionId: String(version.submissionId),
  versionId: String(version._id),
  versionNumber: Number(version.versionNumber),
  parentVersionId: version.parentVersionId ? String(version.parentVersionId) : null,
  reason: version.reason,
  receivedAt: new Date(version.receivedAt).toISOString(),
  manifestChecksum: String(version.manifestChecksum),
  proposalId: String(version.proposalId),
  organizationId: String(version.organizationId),
  ownerUserId: String(submission.proposalOwnerId),
  proposalTitle: String(submission.proposalTitle || "Untitled Proposal"),
  vendorName: String(version.vendorName),
  submittedBy: String(version.submittedBy),
  email: String(version.email),
  message: String(version.message || ""),
  documents: documentRecords(version.documents),
  response,
});

const ensureSubmission = async (input: {
  response: any;
  organizationId: string;
  proposalId: string;
  ownerUserId: string;
  proposalTitle: string;
  vendorName: string;
  email: string;
  trackingId?: string | null;
}) => {
  if (input.response.submissionId) {
    const current = await VendorSubmission.findById(input.response.submissionId).lean<any>();
    if (current) return current;
  }
  const key = identityKey(input.vendorName, input.email);
  let submission = await VendorSubmission.findOne({
    $or: [
      { legacyVendorResponseId: input.response._id },
      {
        organizationId: input.organizationId,
        proposalId: input.proposalId,
        primaryEmail: input.email,
      },
    ],
  }).lean<any>();
  if (!submission) {
    try {
      submission = (
        await VendorSubmission.create({
          organizationId: input.organizationId,
          proposalId: input.proposalId,
          proposalOwnerId: input.ownerUserId,
          proposalTitle: input.proposalTitle,
          vendorIdentityKey: key,
          vendorName: input.vendorName,
          primaryEmail: input.email,
          trackingIds: input.trackingId ? [input.trackingId] : [],
          legacyVendorResponseId: input.response._id,
          currentVersionNumber: 0,
          isRead: input.response.isRead === true,
        })
      ).toObject();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      submission = await VendorSubmission.findOne({
        organizationId: input.organizationId,
        proposalId: input.proposalId,
        $or: [{ vendorIdentityKey: key }, { primaryEmail: input.email }],
      }).lean<any>();
      if (!submission) throw error;
    }
  }
  await VendorResponse.updateOne(
    { _id: input.response._id },
    { $set: { submissionId: submission._id } },
  );
  return submission;
};

const projectLatest = async (input: {
  submission: any;
  version: any;
  trackingId?: string | null;
}) => {
  const updated = await VendorSubmission.findOneAndUpdate(
    {
      _id: input.submission._id,
      currentVersionNumber: { $lt: Number(input.version.versionNumber) },
    },
    {
      $set: {
        vendorName: input.version.vendorName,
        primaryEmail: input.version.email,
        currentVersionId: input.version._id,
        currentVersionNumber: input.version.versionNumber,
        lastSubmittedAt: input.version.receivedAt,
        isRead: false,
      },
      ...(input.trackingId
        ? { $addToSet: { trackingIds: input.trackingId } }
        : {}),
    },
    { new: true },
  ).lean<any>();
  const current = updated ?? (await VendorSubmission.findById(input.submission._id).lean<any>());
  if (!current) throw new Error("Vendor submission disappeared during projection");
  if (String(current.currentVersionId) === String(input.version._id)) {
    await VendorResponse.updateOne(
      { _id: current.legacyVendorResponseId },
      {
        $set: {
          proposalTitle: current.proposalTitle,
          vendorName: input.version.vendorName,
          submittedBy: input.version.submittedBy,
          email: input.version.email,
          message: input.version.message,
          documents: input.version.documents,
          isRead: false,
          submissionId: current._id,
          currentVersionId: input.version._id,
          currentVersionNumber: input.version.versionNumber,
          versionReason: input.version.reason,
          versionReceivedAt: input.version.receivedAt,
          manifestChecksum: input.version.manifestChecksum,
          ...(input.trackingId ? { emailTrackingId: input.trackingId } : {}),
        },
      },
    );
  }
  return current;
};

const ensureLegacyProjected = async (legacy: any): Promise<VendorResponseRecord> => {
  if (legacy.submissionId && Number(legacy.currentVersionNumber) > 0) {
    return responseRecord(String(legacy._id));
  }
  const submission = await ensureSubmission({
    response: legacy,
    organizationId: String(legacy.organizationId),
    proposalId: String(legacy.proposalId),
    ownerUserId: String(legacy.proposalOwnerId),
    proposalTitle: String(legacy.proposalTitle || "Untitled Proposal"),
    vendorName: String(legacy.vendorName),
    email: String(legacy.email).toLowerCase(),
    trackingId: legacy.emailTrackingId ? String(legacy.emailTrackingId) : null,
  });
  let version = await VendorSubmissionVersion.findOne({
    organizationId: legacy.organizationId,
    idempotencyKey: `vendor_submission:legacy:${legacy._id}`,
  }).lean<any>();
  if (!version) {
    const documents = documentRecords(legacy.documents);
    const versionId = new mongoose.Types.ObjectId();
    const manifestChecksum = vendorSubmissionManifestChecksum({
      proposalId: String(legacy.proposalId),
      submissionId: String(submission._id),
      versionNumber: 1,
      reason: "legacy_backfill",
      vendorName: String(legacy.vendorName),
      submittedBy: String(legacy.submittedBy),
      email: String(legacy.email),
      message: String(legacy.message || ""),
      documents,
    });
    try {
      version = (
        await VendorSubmissionVersion.create({
          _id: versionId,
          organizationId: legacy.organizationId,
          proposalId: legacy.proposalId,
          submissionId: submission._id,
          legacyVendorResponseId: legacy._id,
          versionNumber: 1,
          parentVersionId: null,
          reason: "legacy_backfill",
          vendorName: legacy.vendorName,
          submittedBy: legacy.submittedBy,
          email: legacy.email,
          message: legacy.message || "",
          documents,
          manifestChecksum,
          idempotencyKey: `vendor_submission:legacy:${legacy._id}`,
          sourceSystem: "legacy_migration",
          receivedAt: legacy.createdAt || new Date(),
        })
      ).toObject();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      version = await VendorSubmissionVersion.findOne({
        organizationId: legacy.organizationId,
        idempotencyKey: `vendor_submission:legacy:${legacy._id}`,
      }).lean<any>();
      if (!version) throw error;
    }
  }
  await projectLatest({
    submission,
    version,
    trackingId: legacy.emailTrackingId ? String(legacy.emailTrackingId) : null,
  });
  return responseRecord(String(legacy._id));
};

const legacyBySubmission = async (submission: any) => {
  const legacy = await VendorResponse.findById(submission.legacyVendorResponseId).lean<any>();
  return legacy ? ensureLegacyProjected(legacy) : null;
};

export const mongoVendorSubmissionRepository: VendorSubmissionRepository & {
  projectLegacyResponse(responseId: string): Promise<VendorResponseRecord | null>;
} = {
  async findByTrackingId(trackingId) {
    const submission = await VendorSubmission.findOne({ trackingIds: trackingId }).lean<any>();
    if (submission) return legacyBySubmission(submission);
    const legacy = await VendorResponse.findOne({ emailTrackingId: trackingId }).lean<any>();
    return legacy ? ensureLegacyProjected(legacy) : null;
  },

  async findByProposalAndEmail({ proposalId, email }) {
    const submission = await VendorSubmission.findOne({
      proposalId: new mongoose.Types.ObjectId(proposalId),
      primaryEmail: email,
    }).lean<any>();
    if (submission) return legacyBySubmission(submission);
    const legacy = await VendorResponse.findOne({
      proposalId: new mongoose.Types.ObjectId(proposalId),
      email,
    }).lean<any>();
    return legacy ? ensureLegacyProjected(legacy) : null;
  },

  async findExisting({ proposalId, email, trackingId }) {
    if (trackingId) {
      const tracked = await this.findByTrackingId(trackingId);
      if (tracked) return tracked;
    }
    return this.findByProposalAndEmail({ proposalId, email });
  },

  async findVersionByIdempotencyKey({ organizationId, idempotencyKey }) {
    const version = await VendorSubmissionVersion.findOne({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      idempotencyKey,
    }).lean<any>();
    if (!version) return null;
    const submission = await VendorSubmission.findById(version.submissionId).lean<any>();
    if (!submission) return null;
    return toVersionRecord(
      version,
      submission,
      await responseRecord(String(submission.legacyVendorResponseId)),
    );
  },

  async findProposal(proposalId) {
    const proposal = await Proposal.findById(proposalId)
      .select("_id organizationId userId event.eventName")
      .lean<any>();
    if (!proposal) return null;
    return {
      proposalId: String(proposal._id),
      organizationId: String(proposal.organizationId ?? ""),
      ownerUserId: String(proposal.userId ?? ""),
      proposalTitle: proposal.event?.eventName?.trim() || "Untitled Proposal",
    };
  },

  async saveVersion(input) {
    let legacy = input.existingResponse?._id
      ? await VendorResponse.findById(input.existingResponse._id).lean<any>()
      : null;
    if (!legacy) {
      legacy = (
        await VendorResponse.findOneAndUpdate(
          { proposalId: input.proposalId, email: input.email },
          {
            $setOnInsert: {
              organizationId: input.organizationId,
              proposalId: input.proposalId,
              proposalOwnerId: input.ownerUserId,
              proposalTitle: input.proposalTitle,
              vendorName: input.vendorName,
              submittedBy: input.submittedBy,
              email: input.email,
              message: "",
              documents: [],
              ...(input.trackingId ? { emailTrackingId: input.trackingId } : {}),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
      ).toObject();
    }
    const submission = await ensureSubmission({
      response: legacy,
      organizationId: input.organizationId,
      proposalId: input.proposalId,
      ownerUserId: input.ownerUserId,
      proposalTitle: input.proposalTitle,
      vendorName: input.vendorName,
      email: input.email,
      trackingId: input.trackingId,
    });

    const replay = await VendorSubmissionVersion.findOne({
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
    }).lean<any>();
    if (replay) {
      const current = await projectLatest({
        submission,
        version: replay,
        trackingId: input.trackingId,
      });
      return {
        record: toVersionRecord(
          replay,
          current,
          await responseRecord(String(current.legacyVendorResponseId)),
        ),
        created: false,
      };
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await VendorSubmission.findById(submission._id).lean<any>();
      if (!current) throw new Error("Vendor submission disappeared during version creation");
      const parent = current.currentVersionId
        ? await VendorSubmissionVersion.findById(current.currentVersionId).lean<any>()
        : null;
      const versionNumber = Number(current.currentVersionNumber || 0) + 1;
      const reason =
        versionNumber > 1 && input.reason === "initial"
          ? "vendor_revision"
          : input.reason;
      const inherited = parent
        ? documentRecords(parent.documents, String(parent._id))
        : documentRecords(legacy.documents);
      const documents = [...inherited, ...input.newDocuments];
      const manifestChecksum = vendorSubmissionManifestChecksum({
        proposalId: input.proposalId,
        submissionId: String(current._id),
        versionNumber,
        reason,
        vendorName: input.vendorName,
        submittedBy: input.submittedBy,
        email: input.email,
        message: input.message,
        documents,
      });
      try {
        const version = (
          await VendorSubmissionVersion.create({
            organizationId: input.organizationId,
            proposalId: input.proposalId,
            submissionId: current._id,
            legacyVendorResponseId: legacy._id,
            versionNumber,
            parentVersionId: parent?._id ?? null,
            reason,
            vendorName: input.vendorName,
            submittedBy: input.submittedBy,
            email: input.email,
            message: input.message,
            documents,
            manifestChecksum,
            idempotencyKey: input.idempotencyKey,
            sourceSystem: input.sourceSystem,
            receivedAt: input.receivedAt,
          })
        ).toObject();
        const projected = await projectLatest({
          submission: current,
          version,
          trackingId: input.trackingId,
        });
        return {
          record: toVersionRecord(
            version,
            projected,
            await responseRecord(String(projected.legacyVendorResponseId)),
          ),
          created: true,
        };
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const duplicate = await VendorSubmissionVersion.findOne({
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        }).lean<any>();
        if (duplicate) {
          const projected = await projectLatest({
            submission: current,
            version: duplicate,
            trackingId: input.trackingId,
          });
          return {
            record: toVersionRecord(
              duplicate,
              projected,
              await responseRecord(String(projected.legacyVendorResponseId)),
            ),
            created: false,
          };
        }
      }
    }
    throw new Error("Vendor submission version could not be allocated safely");
  },

  async getReceipt({ proposalId, versionId, email }) {
    const version = await VendorSubmissionVersion.findOne({
      _id: versionId,
      proposalId,
      email: email.trim().toLowerCase(),
    }).lean<any>();
    if (!version) return null;
    const submission = await VendorSubmission.findById(version.submissionId).lean<any>();
    if (!submission) return null;
    const record = toVersionRecord(version, submission, {});
    return {
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
      documents: record.documents,
    };
  },

  async projectLegacyResponse(responseId) {
    const legacy = await VendorResponse.findById(responseId).lean<any>();
    return legacy ? ensureLegacyProjected(legacy) : null;
  },
};
