import mongoose from "mongoose";
import EmailCampaign from "../../../../../modal/emailModel";
import VendorResponse from "../../../../../modal/vendorResponseModel";
import VendorSubmission from "../../../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../../../modal/vendorSubmissionVersionModel";
import type { VendorResponseReadRepository } from "../../domain/ports/vendorResponseReadRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const VENDOR_RESPONSE_SELECT =
  "_id proposalId proposalOwnerId proposalTitle vendorName submittedBy email message documents isRead createdAt updatedAt submissionId currentVersionId currentVersionNumber versionReason versionReceivedAt manifestChecksum";

type TimelineResponse = { submissionId?: unknown };
type TimelineSubmission = {
  _id: unknown;
  organizationId: unknown;
  status: "active" | "withdrawn" | "archived";
  currentVersionId?: unknown;
  currentVersionNumber?: number;
  createdAt: Date;
  updatedAt: Date;
};
type TimelineDocument = {
  documentId: string;
  sourceId: string;
  name: string;
  url: string;
  mimeType?: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  scanStatus: "clean" | "skipped" | "legacy_unknown";
  inheritedFromVersionId?: unknown;
};
type TimelineVersion = {
  _id: unknown;
  versionNumber: number;
  parentVersionId?: unknown;
  reason: string;
  sourceSystem: string;
  receivedAt: Date;
  manifestChecksum: string;
  vendorName: string;
  submittedBy: string;
  email: string;
  message?: string;
  documents?: TimelineDocument[];
};

export const mongoVendorResponseReadRepository: VendorResponseReadRepository = {
  async listOwned({
    ownerUserId,
    unreadOnly,
    proposalId,
    campaignId,
    page,
    limit,
  }) {
    const ownerId = new mongoose.Types.ObjectId(ownerUserId);
    const filter: Record<string, unknown> = {
      proposalOwnerId: ownerId,
      ...tenantFilter(),
    };
    if (unreadOnly) filter.isRead = false;

    if (campaignId) {
      const campaign = await EmailCampaign.findOne({
        _id: new mongoose.Types.ObjectId(campaignId),
        userId: ownerId,
        ...tenantFilter(),
      })
        .select("recipients.trackingId")
        .lean();
      const trackingIds = (campaign?.recipients ?? [])
        .map((recipient) => recipient.trackingId)
        .filter(Boolean);
      if (trackingIds.length === 0) {
        return { responses: [], total: 0, unreadCount: 0 };
      }
      filter.emailTrackingId = { $in: trackingIds };
    } else if (proposalId) {
      filter.proposalId = new mongoose.Types.ObjectId(proposalId);
    }

    const [responses, total, unreadCount] = await Promise.all([
      VendorResponse.find(filter)
        .select(VENDOR_RESPONSE_SELECT)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      VendorResponse.countDocuments(filter),
      VendorResponse.countDocuments({
        proposalOwnerId: ownerId,
        isRead: false,
        ...tenantFilter(),
      }),
    ]);
    return { responses, total, unreadCount };
  },

  markOwnedRead({ responseId, ownerUserId }) {
    return VendorResponse.findOneAndUpdate(
      {
        _id: responseId,
        proposalOwnerId: new mongoose.Types.ObjectId(ownerUserId),
        ...tenantFilter(),
      },
      { isRead: true },
      { new: true },
    )
      .select(VENDOR_RESPONSE_SELECT)
      .lean();
  },

  async getOwnedSubmissionTimeline({ responseId, ownerUserId }) {
    const ownerId = new mongoose.Types.ObjectId(ownerUserId);
    const response = await VendorResponse.findOne({
      _id: responseId,
      proposalOwnerId: ownerId,
      ...tenantFilter(),
    })
      .select("submissionId")
      .lean<TimelineResponse>();
    if (!response) return null;
    if (!response.submissionId)
      return { historyTruncated: false, submission: null, versions: [] };

    const submission = await VendorSubmission.findOne({
      _id: response.submissionId,
      legacyVendorResponseId: responseId,
      proposalOwnerId: ownerId,
      ...tenantFilter(),
    }).lean<TimelineSubmission>();
    if (!submission)
      return { historyTruncated: false, submission: null, versions: [] };

    const versions = await VendorSubmissionVersion.find({
      submissionId: submission._id,
      organizationId: submission.organizationId,
    })
      .sort({ versionNumber: -1 })
      .limit(101)
      .lean<TimelineVersion[]>();
    const historyTruncated = versions.length > 100;

    return {
      historyTruncated,
      submission: {
        submissionId: String(submission._id),
        status: submission.status,
        currentVersionId: submission.currentVersionId
          ? String(submission.currentVersionId)
          : null,
        currentVersionNumber: Number(submission.currentVersionNumber || 0),
        createdAt: new Date(submission.createdAt).toISOString(),
        updatedAt: new Date(submission.updatedAt).toISOString(),
      },
      versions: versions.slice(0, 100).map((version) => ({
        versionId: String(version._id),
        versionNumber: Number(version.versionNumber),
        parentVersionId: version.parentVersionId
          ? String(version.parentVersionId)
          : null,
        reason: String(version.reason),
        sourceSystem: String(version.sourceSystem),
        receivedAt: new Date(version.receivedAt).toISOString(),
        manifestChecksum: String(version.manifestChecksum),
        vendorName: String(version.vendorName),
        submittedBy: String(version.submittedBy),
        email: String(version.email),
        message: String(version.message || ""),
        documents: (version.documents ?? []).map((document) => ({
          documentId: String(document.documentId),
          sourceId: String(document.sourceId),
          name: String(document.name),
          url: String(document.url),
          mimeType: String(document.mimeType || "application/octet-stream"),
          sizeBytes:
            typeof document.sizeBytes === "number" ? document.sizeBytes : null,
          sha256: document.sha256 ? String(document.sha256) : null,
          scanStatus: document.scanStatus,
          inheritedFromVersionId: document.inheritedFromVersionId
            ? String(document.inheritedFromVersionId)
            : null,
        })),
      })),
    };
  },
};
