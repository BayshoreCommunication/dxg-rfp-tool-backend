import Proposal from "../../../../../modal/proposalsModel";
import mongoose, { type PipelineStage } from "mongoose";
import type {
  ListOwnedProposalRepositoryInput,
  ProposalListCounts,
  ProposalReadRepository,
} from "../../domain/ports/proposalReadRepository";
import { tenantFilter, tenantObjectId } from "../../../shared/tenancy/tenantContext";

const DETAIL_PROPOSAL_SELECT = "-__v";
const LIST_PROPOSAL_SELECT = [
  "_id", "status", "isDraft", "isActive", "isFavorite", "isAccepted",
  "isOpen", "isArchived", "archivedAt", "isCopy", "viewsCount",
  "createdAt", "updatedAt", "event.eventName", "contact.contactFirstName",
  "contact.contactLastName",
].join(" ");

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const searchConditions = (search: string) => {
  const regex = new RegExp(escapeRegex(search), "i");
  return [
    { "event.eventName": regex },
    { "contact.contactFirstName": regex },
    { "contact.contactLastName": regex },
    { "contact.contactEmail": regex },
    { "contact.contactOrganization": regex },
  ];
};

const buildListFilter = (input: ListOwnedProposalRepositoryInput) => {
  const filter: Record<string, unknown> = {
    userId: input.ownerUserId,
    ...tenantFilter(),
    isArchived: input.archived ? true : { $ne: true },
  };
  if (input.status) filter.status = input.status;
  if (input.isDraft !== undefined) filter.isDraft = input.isDraft;
  const expiredThreshold = input.expiryDays
    ? new Date(Date.now() - input.expiryDays * 24 * 60 * 60 * 1000)
    : null;
  if (input.isActive === false && expiredThreshold) {
    filter.$or = [
      { isActive: false },
      { isActive: { $ne: false }, createdAt: { $lte: expiredThreshold } },
    ];
  } else if (input.isActive !== undefined) {
    filter.isActive = input.isActive;
  }
  if (input.favorite !== undefined) filter.isFavorite = input.favorite;
  if (input.isCopy) filter.isCopy = true;
  else if (!input.archived) filter.isCopy = { $ne: true };
  if (input.search) {
    const conditions = searchConditions(input.search);
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: conditions }];
      delete filter.$or;
    } else filter.$or = conditions;
  }
  return filter;
};

const buildCountsAggregation = (
  input: ListOwnedProposalRepositoryInput,
): PipelineStage[] => {
  const expiredThreshold = input.expiryDays
    ? new Date(Date.now() - input.expiryDays * 24 * 60 * 60 * 1000)
    : null;
  const baseFilter: Record<string, unknown> = {
    userId: new mongoose.Types.ObjectId(input.ownerUserId),
    organizationId: tenantObjectId(),
  };
  if (input.search) baseFilter.$or = searchConditions(input.search);
  const notArchived = { $ne: ["$isArchived", true] };
  const notCopy = { $ne: ["$isCopy", true] };
  return [
    { $match: baseFilter },
    {
      $group: {
        _id: null,
        all: { $sum: { $cond: [{ $and: [notArchived, notCopy] }, 1, 0] } },
        draft: { $sum: { $cond: [{ $and: [notArchived, notCopy, { $eq: ["$isDraft", true] }] }, 1, 0] } },
        live: { $sum: { $cond: [expiredThreshold ? { $and: [notArchived, notCopy, { $eq: ["$isDraft", false] }, { $eq: ["$status", "submitted"] }, { $ne: ["$isActive", false] }, { $gt: ["$createdAt", expiredThreshold] }] } : { $and: [notArchived, notCopy, { $eq: ["$isDraft", false] }, { $eq: ["$status", "submitted"] }, { $ne: ["$isActive", false] }] }, 1, 0] } },
        favorite: { $sum: { $cond: [{ $and: [notArchived, notCopy, { $eq: ["$isFavorite", true] }] }, 1, 0] } },
        expired: { $sum: { $cond: [expiredThreshold ? { $and: [notArchived, notCopy, { $eq: ["$isDraft", false] }, { $or: [{ $eq: ["$isActive", false] }, { $and: [{ $ne: ["$isActive", false] }, { $lte: ["$createdAt", expiredThreshold] }] }] }] } : { $and: [notArchived, notCopy, { $eq: ["$isDraft", false] }, { $eq: ["$isActive", false] }] }, 1, 0] } },
        archive: { $sum: { $cond: [{ $eq: ["$isArchived", true] }, 1, 0] } },
        saved: { $sum: { $cond: [{ $and: [notArchived, { $eq: ["$isCopy", true] }] }, 1, 0] } },
      },
    },
  ];
};

export const mongoProposalReadRepository: ProposalReadRepository = {
  async findOwnedById({ proposalId, ownerUserId }) {
    return Proposal.findOne({ _id: proposalId, userId: ownerUserId, ...tenantFilter() })
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
  },

  async listOwned(input) {
    const filter = buildListFilter(input);
    const sort = {
      [input.sortBy]: input.sortOrder === "asc" ? (1 as const) : (-1 as const),
      _id: input.sortOrder === "asc" ? (1 as const) : (-1 as const),
    };
    const [proposals, total, countsRows] = await Promise.all([
      Proposal.find(filter)
        .select(LIST_PROPOSAL_SELECT)
        .sort(sort)
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .lean(),
      Proposal.countDocuments(filter),
      input.includeCounts
        ? Proposal.aggregate<ProposalListCounts>(buildCountsAggregation(input))
        : Promise.resolve([]),
    ]);
    const row = countsRows[0];
    const counts = input.includeCounts
      ? {
          all: row?.all ?? 0,
          draft: row?.draft ?? 0,
          live: row?.live ?? 0,
          favorite: row?.favorite ?? 0,
          expired: row?.expired ?? 0,
          archive: row?.archive ?? 0,
          saved: row?.saved ?? 0,
        }
      : undefined;
    return { proposals, total, counts };
  },
};
