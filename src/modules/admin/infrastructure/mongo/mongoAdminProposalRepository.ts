import Proposal from "../../../../../modal/proposalsModel";
import User from "../../../../../modal/userModel";
import type {
  AdminProposalItem,
  AdminProposalRepository,
  AdminProposalView,
} from "../../domain/ports/adminProposalRepository";
import { tenantObjectId } from "../../../shared/tenancy/tenantContext";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const VIEW_MATCH: Record<AdminProposalView, Record<string, unknown>> = {
  all: {},
  draft: { isDraft: true, isArchived: { $ne: true } },
  published: { isDraft: false, isArchived: { $ne: true } },
  archived: { isArchived: true },
};

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const toItem = (doc: Record<string, unknown>): AdminProposalItem => {
  const event = (doc.event ?? {}) as Record<string, unknown>;
  const planner = doc.planner as Record<string, unknown> | undefined;
  return {
    id: String(doc._id),
    eventName: text(event.eventName) ?? "Untitled event",
    status: String(doc.status ?? "unsubmitted"),
    isDraft: doc.isDraft === true,
    isActive: doc.isActive !== false,
    isArchived: doc.isArchived === true,
    isCopy: doc.isCopy === true,
    viewsCount: Number(doc.viewsCount ?? 0),
    startDate: text(event.startDate),
    endDate: text(event.endDate),
    attendees: text(event.attendees),
    eventFormat: text(event.eventFormat),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
    planner: planner
      ? {
          id: String(planner._id),
          name: text(planner.name),
          email: text(planner.email),
          company: text(planner.company),
        }
      : null,
  };
};

// Internal bookkeeping a reader never needs.
const HIDDEN_FIELDS = ["__v", "organizationId", "candidateApplicationIds", "proposalSettings"];

export const mongoAdminProposalRepository: AdminProposalRepository = {
  async findById(id) {
    const doc = await Proposal.findOne({ _id: id, organizationId: tenantObjectId() }).lean<Record<string, unknown>>();
    if (!doc) return null;
    const planner = doc.userId
      ? await User.findById(doc.userId).select("name email company").lean<Record<string, unknown>>()
      : null;
    const { _id, ...rest } = doc;
    for (const field of HIDDEN_FIELDS) delete rest[field];
    return {
      proposal: { ...rest, id: String(_id), userId: doc.userId ? String(doc.userId) : null },
      planner: planner
        ? { id: String(planner._id), name: text(planner.name), email: text(planner.email), company: text(planner.company) }
        : null,
    };
  },

  async list({ page, perPage, search, view }) {
    const base = { organizationId: tenantObjectId() };
    // The planner is looked up before searching so their name and email are searchable.
    const withPlanner = [
      { $match: base },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1, email: 1, company: 1 } }],
          as: "planner",
        },
      },
      { $set: { planner: { $first: "$planner" } } },
      ...(search
        ? [
            {
              $match: {
                $or: [
                  { "event.eventName": new RegExp(escapeRegex(search), "i") },
                  { "planner.name": new RegExp(escapeRegex(search), "i") },
                  { "planner.email": new RegExp(escapeRegex(search), "i") },
                  { "contact.contactEmail": new RegExp(escapeRegex(search), "i") },
                ],
              },
            },
          ]
        : []),
    ];
    const [result] = await Proposal.aggregate<{
      counts: { _id: null; all: number; draft: number; published: number; archived: number }[];
      metadata: { total: number }[];
      data: Record<string, unknown>[];
    }>([
      ...withPlanner,
      {
        $facet: {
          counts: [
            {
              $group: {
                _id: null,
                all: { $sum: 1 },
                draft: { $sum: { $cond: [{ $and: [{ $eq: ["$isDraft", true] }, { $ne: ["$isArchived", true] }] }, 1, 0] } },
                published: { $sum: { $cond: [{ $and: [{ $eq: ["$isDraft", false] }, { $ne: ["$isArchived", true] }] }, 1, 0] } },
                archived: { $sum: { $cond: [{ $eq: ["$isArchived", true] }, 1, 0] } },
              },
            },
          ],
          metadata: [{ $match: VIEW_MATCH[view] }, { $count: "total" }],
          data: [
            { $match: VIEW_MATCH[view] },
            { $sort: { updatedAt: -1, _id: -1 } },
            { $skip: (page - 1) * perPage },
            { $limit: perPage },
            {
              $project: {
                status: 1, isDraft: 1, isActive: 1, isArchived: 1, isCopy: 1, viewsCount: 1,
                createdAt: 1, updatedAt: 1, planner: 1,
                "event.eventName": 1, "event.startDate": 1, "event.endDate": 1,
                "event.attendees": 1, "event.eventFormat": 1,
              },
            },
          ],
        },
      },
    ]);
    const counts = result?.counts?.[0];
    return {
      proposals: (result?.data ?? []).map(toItem),
      total: result?.metadata?.[0]?.total ?? 0,
      counts: {
        all: counts?.all ?? 0,
        draft: counts?.draft ?? 0,
        published: counts?.published ?? 0,
        archived: counts?.archived ?? 0,
      },
    };
  },
};
