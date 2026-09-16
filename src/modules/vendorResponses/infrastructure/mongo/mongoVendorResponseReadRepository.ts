import mongoose from "mongoose";
import EmailCampaign from "../../../../../modal/emailModel";
import VendorResponse from "../../../../../modal/vendorResponseModel";
import VendorSubmission from "../../../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../../../modal/vendorSubmissionVersionModel";
import type { VendorResponseCalculationV1 } from "../../../../../contracts/generated/vendor-response-calculation-v1";
import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../../contracts/generated/vendor-response-v1";
import type {
  StructuredResponseSummary,
  VendorResponseReadRepository,
} from "../../domain/ports/vendorResponseReadRepository";
import {
  tenantFilter,
  tenantObjectId,
} from "../../../shared/tenancy/tenantContext";

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
  purposeId?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
  versionDisposition?: unknown;
  inheritedFromVersionId?: unknown;
};
type TimelineVersion = {
  _id: unknown;
  versionNumber: number;
  parentVersionId?: unknown;
  reason: string;
  sourceSystem: string;
  responseSchemaVersion?: string | null;
  questionnaireSnapshot?: VendorResponseQuestionnaireV1 | null;
  structuredResponse?: VendorResponseV1 | null;
  calculationSnapshot?: VendorResponseCalculationV1 | null;
  retiredDocuments?: Array<{ documentId?: unknown; retiredFromVersionId?: unknown }>;
  receivedAt: Date;
  manifestChecksum: string;
  vendorName: string;
  submittedBy: string;
  email: string;
  message?: string;
  documents?: TimelineDocument[];
};

type ResponseSummaryRecord = Record<string, unknown> & { currentVersionId?: unknown };
type SummaryVersion = {
  _id: unknown;
  responseSchemaVersion?: string | null;
  questionnaireId?: unknown;
  questionnaireVersion?: unknown;
  questionnaireChecksum?: unknown;
  proposalVersion?: unknown;
  questionnaireSnapshot?: VendorResponseQuestionnaireV1 | null;
  structuredResponse?: VendorResponseV1 | null;
  calculationSnapshot?: VendorResponseCalculationV1 | null;
};

const structuredSummary = (version?: SummaryVersion): StructuredResponseSummary | null => {
  if (
    version?.responseSchemaVersion !== "vendor-response.v1"
    || !version.questionnaireSnapshot
    || !version.structuredResponse
    || !version.calculationSnapshot
  ) return null;
  const response = version.structuredResponse;
  const questionnaire = version.questionnaireSnapshot;
  const documentCounts = new Map<string, number>();
  for (const document of Array.isArray(response.documents) ? response.documents : []) {
    const purposeId = String(document?.purposeId ?? "other");
    documentCounts.set(purposeId, (documentCounts.get(purposeId) ?? 0) + 1);
  }
  const questionnaireRooms = Array.isArray(questionnaire.rooms)
    ? questionnaire.rooms.length
    : 0;
  const responseRooms = Array.isArray(response.rooms) ? response.rooms.length : 0;
  return {
    questionnaire: {
      questionnaireId: String(version.questionnaireId ?? questionnaire.questionnaireId),
      questionnaireVersion: Number(version.questionnaireVersion ?? questionnaire.questionnaireVersion),
      questionnaireChecksum: String(version.questionnaireChecksum ?? questionnaire.questionnaireChecksum),
      proposalVersion: Number(version.proposalVersion ?? questionnaire.proposalVersion),
      decimalPrecision: Number(questionnaire.context?.decimalPrecision ?? 2),
    },
    calculation: version.calculationSnapshot,
    roomCoverage: {
      total: questionnaireRooms,
      responded: Math.min(questionnaireRooms, responseRooms),
    },
    crewCount: Array.isArray(response.crew) ? response.crew.length : 0,
    alternateCount: Array.isArray(response.alternates) ? response.alternates.length : 0,
    referenceCount: Array.isArray(response.references) ? response.references.length : 0,
    documentCounts: [...documentCounts.entries()].map(([purposeId, count]) => ({
      purposeId,
      count,
    })),
  };
};

const withCurrentVersionSummary = async <T extends ResponseSummaryRecord>(responses: T[]) => {
  const currentIds = responses
    .map((response) => response.currentVersionId)
    .filter(Boolean);
  if (currentIds.length === 0) {
    return responses.map((response) => ({
      ...response,
      responseFormat: "legacy_unstructured",
      structuredSummary: null,
    }));
  }
  const versions = await VendorSubmissionVersion.find({ _id: { $in: currentIds } })
    .select("_id responseSchemaVersion questionnaireId questionnaireVersion questionnaireChecksum proposalVersion questionnaireSnapshot structuredResponse calculationSnapshot")
    .lean<SummaryVersion[]>();
  const byId = new Map(versions.map((version) => [String(version._id), version]));
  return responses.map((response) => {
    const version = byId.get(String(response.currentVersionId ?? ""));
    const summary = structuredSummary(version);
    return {
      ...response,
      responseFormat: summary ? "structured_v1" : "legacy_unstructured",
      structuredSummary: summary,
    };
  });
};

export const mongoVendorResponseReadRepository: VendorResponseReadRepository = {
  async listOwnedProposalSummaries({
    ownerUserId,
    search,
    page,
    limit,
  }) {
    const ownerId = new mongoose.Types.ObjectId(ownerUserId);
    const baseFilter: Record<string, unknown> = {
      proposalOwnerId: ownerId,
      // Mongoose casts find filters but does not cast aggregation pipelines.
      organizationId: tenantObjectId(),
    };
    const escapedSearch = search?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const groupedFilter = escapedSearch
      ? { proposalTitle: { $regex: escapedSearch, $options: "i" } }
      : {};

    const [grouped, totals] = await Promise.all([
      VendorResponse.aggregate<{
        proposals: Array<{
          _id: mongoose.Types.ObjectId;
          proposalTitle: string;
          responseCount: number;
          responseIds: mongoose.Types.ObjectId[];
          unreadCount: number;
          latestResponseAt: Date;
          latestVendorName: string;
        }>;
        total: Array<{ count: number }>;
      }>([
        { $match: baseFilter },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$proposalId",
            proposalTitle: { $first: "$proposalTitle" },
            responseCount: { $sum: 1 },
            responseIds: { $push: "$_id" },
            unreadCount: {
              $sum: { $cond: [{ $eq: ["$isRead", false] }, 1, 0] },
            },
            latestResponseAt: { $first: "$createdAt" },
            latestVendorName: { $first: "$vendorName" },
          },
        },
        { $match: groupedFilter },
        { $sort: { latestResponseAt: -1, _id: 1 } },
        {
          $facet: {
            proposals: [{ $skip: (page - 1) * limit }, { $limit: limit }],
            total: [{ $count: "count" }],
          },
        },
      ]),
      VendorResponse.aggregate<{ responseCount: number; unreadCount: number }>([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            responseCount: { $sum: 1 },
            unreadCount: {
              $sum: { $cond: [{ $eq: ["$isRead", false] }, 1, 0] },
            },
          },
        },
      ]),
    ]);
    const result = grouped[0];
    return {
      proposals: (result?.proposals ?? []).map((proposal) => ({
        proposalId: String(proposal._id),
        proposalTitle: String(proposal.proposalTitle || "Untitled proposal"),
        responseCount: Number(proposal.responseCount || 0),
        responseIds: (proposal.responseIds ?? []).map((responseId) =>
          String(responseId),
        ),
        unreadCount: Number(proposal.unreadCount || 0),
        latestResponseAt: new Date(proposal.latestResponseAt).toISOString(),
        latestVendorName: String(proposal.latestVendorName || "Unknown vendor"),
      })),
      total: Number(result?.total[0]?.count || 0),
      responseCount: Number(totals[0]?.responseCount || 0),
      unreadCount: Number(totals[0]?.unreadCount || 0),
    };
  },

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
        return {
          responses: [],
          total: 0,
          unreadCount: await VendorResponse.countDocuments({
            proposalOwnerId: ownerId,
            isRead: false,
            ...tenantFilter(),
          }),
          filteredUnreadCount: 0,
        };
      }
      filter.emailTrackingId = { $in: trackingIds };
    } else if (proposalId) {
      filter.proposalId = new mongoose.Types.ObjectId(proposalId);
    }

    const [responses, total, unreadCount, filteredUnreadCount] = await Promise.all([
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
      VendorResponse.countDocuments({
        ...filter,
        isRead: false,
      }),
    ]);
    return {
      responses: await withCurrentVersionSummary(responses),
      total,
      unreadCount,
      filteredUnreadCount,
    };
  },

  async markOwnedRead({ responseId, ownerUserId }) {
    const response = await VendorResponse.findOneAndUpdate(
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
    if (!response) return null;
    return (await withCurrentVersionSummary([response]))[0] ?? null;
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
        format: version.responseSchemaVersion === "vendor-response.v1"
          ? "structured_v1"
          : "legacy_unstructured",
        receivedAt: new Date(version.receivedAt).toISOString(),
        manifestChecksum: String(version.manifestChecksum),
        vendorName: String(version.vendorName),
        submittedBy: String(version.submittedBy),
        email: String(version.email),
        message: String(version.message || ""),
        questionnaire: version.responseSchemaVersion === "vendor-response.v1"
          ? version.questionnaireSnapshot ?? null
          : null,
        structuredResponse: version.responseSchemaVersion === "vendor-response.v1"
          ? version.structuredResponse ?? null
          : null,
        calculationSnapshot: version.responseSchemaVersion === "vendor-response.v1"
          ? version.calculationSnapshot ?? null
          : null,
        retiredDocuments: (version.retiredDocuments ?? []).flatMap((document) =>
          document.documentId && document.retiredFromVersionId
            ? [{
                documentId: String(document.documentId),
                retiredFromVersionId: String(document.retiredFromVersionId),
              }]
            : [],
        ),
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
          purposeId: document.purposeId ? String(document.purposeId) : null,
          scopeType: ["proposal", "room", "crew_member", "reference"].includes(String(document.scopeType))
            ? document.scopeType as "proposal" | "room" | "crew_member" | "reference"
            : null,
          scopeId: document.scopeId ? String(document.scopeId) : null,
          versionDisposition: ["added", "inherited", "legacy"].includes(String(document.versionDisposition))
            ? document.versionDisposition as "added" | "inherited" | "legacy"
            : "legacy",
          inheritedFromVersionId: document.inheritedFromVersionId
            ? String(document.inheritedFromVersionId)
            : null,
        })),
      })),
    };
  },
};
