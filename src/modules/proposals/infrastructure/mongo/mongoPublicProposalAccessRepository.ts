import Proposal from "../../../../../modal/proposalsModel";
import type {
  LegacyPublicProposal,
  PublicProposalAccessRepository,
} from "../../domain/ports/publicProposalAccessRepository";

const DETAIL_PROPOSAL_SELECT = "-__v";

/**
 * Redaction approach: deny-list, applied at the repository boundary.
 *
 * The unauthenticated public route serves the legacy Mongo document shape
 * that the dashboard's vendor-facing template (ProposalRfpTemplate) renders
 * directly. The canonical projection `toPublicProposalV1` was considered but
 * it targets the proposal-v1 contract shape (content/presentation/lifecycle),
 * not the legacy shape this route returns — adopting it here would break the
 * public template. The template legitimately renders event, venue, schedule,
 * room specs, budget/bid details, uploads (incl. co-vendor contacts), and the
 * planner's contact block, so those stay. We strip only fields that are
 * clearly internal owner/tenant metadata that no public consumer reads.
 */
const PUBLIC_REDACTED_FIELDS = [
  "userId", // owner's internal user id (still used internally as ownerUserId)
  "organizationId", // internal tenant id
  "candidateApplicationIds", // internal applicant linkage (select:false, stripped defensively)
  "isDraft",
  "isFavorite",
  "isAccepted",
  "isOpen",
  "isArchived",
  "archivedAt",
  "isCopy",
] as const;

const PRIVATE_UPLOAD_FIELDS = [
  "brandGuideFiles",
  "eventLogoFiles",
  "referenceFiles",
  "venueDocs",
  "ndaDocumentFiles",
  "scenicInspirationFiles",
  "venueCoiFiles",
] as const;

const attachmentFilename = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const segment = value.split("/").pop() || value;
  try {
    return decodeURIComponent(segment).replace(/^\d+-\d+-/, "");
  } catch {
    return segment.replace(/^\d+-\d+-/, "");
  }
};

export const redactPrivateUploadUrls = (uploads: unknown): unknown => {
  if (!uploads || typeof uploads !== "object" || Array.isArray(uploads)) return uploads;
  const redacted = { ...(uploads as Record<string, unknown>) };
  for (const field of PRIVATE_UPLOAD_FIELDS) {
    if (Array.isArray(redacted[field])) {
      redacted[field] = (redacted[field] as unknown[])
        .map(attachmentFilename)
        .filter(Boolean);
    }
  }
  return redacted;
};

export const redactProposalForPublicView = (
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const redacted: Record<string, unknown> = { ...record };
  for (const field of PUBLIC_REDACTED_FIELDS) {
    delete redacted[field];
  }
  redacted.uploads = redactPrivateUploadUrls(redacted.uploads);
  return redacted;
};

const mapResult = (proposal: unknown): LegacyPublicProposal | null => {
  if (!proposal || typeof proposal !== "object") return null;
  const record = proposal as Record<string, unknown>;
  return {
    ownerUserId: record.userId ? String(record.userId) : "",
    proposal: redactProposalForPublicView(record),
  };
};

export const mongoPublicProposalAccessRepository: PublicProposalAccessRepository = {
  async findByLegacyPublicId(proposalId) {
    const proposal = await Proposal.findById(proposalId)
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
    return mapResult(proposal);
  },

  async incrementViewsByLegacyPublicId(proposalId) {
    const proposal = await Proposal.findByIdAndUpdate(
      proposalId,
      { $inc: { viewsCount: 1 } },
      { new: true },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
    return mapResult(proposal);
  },
};
