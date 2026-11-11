import { Types, type PipelineStage } from "mongoose";
import Proposal from "../../../modal/proposalsModel";
import Team from "../../../modal/teamModel";
import User from "../../../modal/userModel";
import { rfpListScope, type RfpActor } from "../identity/domain/rfpAccessPolicy";
import { LIFECYCLE_STAGES, type LifecycleStage } from "../proposalLifecycle/domain";
import { ACTIVE_STAGES, emptyByStage, type DashboardFilters, type DashboardSummary, type ListRequest, type Quarter } from "./domain";

export type DashboardItem = {
  id: string;
  eventName: string;
  stage: LifecycleStage;
  status: string | null;
  isDraft: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  eventStartDate: string | null;
  eventEndDate: string | null;
  venueCity: string | null;
  vendorsInvited: number;
  vendorsResponded: number;
  reviewStartedAt: Date | null;
  awardedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export interface RfpDashboardRepository {
  list(actor: RfpActor, request: ListRequest): Promise<{ items: DashboardItem[]; total: number }>;
  summary(actor: RfpActor, filters: DashboardFilters, quarter: Quarter): Promise<DashboardSummary>;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The stored stage, or for a proposal the lifecycle backfill hasn't reached yet, the stage its
// flags alone give (it has no recorded vendor, review or award facts). Same precedence as
// deriveLifecycleStage.
const EFFECTIVE_STAGE = {
  $ifNull: [
    "$lifecycle.stage",
    {
      $switch: {
        branches: [
          { case: { $eq: ["$isArchived", true] }, then: "archived" },
          { case: { $or: [{ $eq: ["$isDraft", true] }, { $in: [{ $ifNull: ["$status", "unsubmitted"] }, ["unsubmitted"]] }] }, then: "draft" },
        ],
        default: "sent",
      },
    },
  ],
};

// One filter for both the list and the summary, so the summary is always an aggregate of the
// list. Stage-independent conditions come first so the access scope and indexes do the work.
const pipelineFor = (actor: RfpActor, filters: DashboardFilters): PipelineStage[] => {
  const conditions: Record<string, unknown>[] = [
    // $match doesn't cast, so the scope is built from ObjectIds (rfpListScope does this).
    rfpListScope(actor, "view"),
    // Saved copies are templates, not RFPs.
    { isCopy: { $ne: true } },
  ];
  // Archived is decided by the flag alone, for both stored and derived stages.
  const wantsArchived = filters.stages.includes("archived");
  if (!wantsArchived) conditions.push({ isArchived: { $ne: true } });
  else if (filters.stages.length === 1) conditions.push({ isArchived: true });
  if (filters.ownerUserId) conditions.push({ userId: new Types.ObjectId(filters.ownerUserId) });
  if (filters.teamId) conditions.push({ teamId: new Types.ObjectId(filters.teamId) });
  if (filters.eventFrom || filters.eventTo) {
    conditions.push({
      "event.startDate": {
        ...(filters.eventFrom ? { $gte: filters.eventFrom } : { $gt: "" }),
        ...(filters.eventTo ? { $lte: filters.eventTo } : {}),
      },
    });
  }
  if (filters.venueCity) conditions.push({ "venueSchedule.venueCity": new RegExp(`^\\s*${escapeRegex(filters.venueCity)}\\s*$`, "i") });
  if (filters.search) conditions.push({ "event.eventName": new RegExp(escapeRegex(filters.search), "i") });

  const stages: PipelineStage[] = [{ $match: { $and: conditions } }, { $addFields: { effectiveStage: EFFECTIVE_STAGE } }];
  if (filters.stages.length > 0) stages.push({ $match: { effectiveStage: { $in: filters.stages } } });
  return stages;
};

const SORT_PATHS: Record<ListRequest["sortBy"], string> = {
  updatedAt: "updatedAt",
  createdAt: "createdAt",
  eventStartDate: "event.startDate",
  eventName: "event.eventName",
};

type Row = {
  _id: Types.ObjectId;
  effectiveStage: LifecycleStage;
  status?: string;
  isDraft?: boolean;
  userId?: Types.ObjectId;
  teamId?: Types.ObjectId | null;
  event?: { eventName?: string; startDate?: string; endDate?: string };
  venueSchedule?: { venueCity?: unknown };
  lifecycle?: { vendorsInvited?: number; vendorsResponded?: number; reviewStartedAt?: Date | null; awardedAt?: Date | null };
  createdAt?: Date;
  updatedAt?: Date;
};

const nonEmpty = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export const mongoRfpDashboardRepository: RfpDashboardRepository = {
  async list(actor, request) {
    const direction = request.sortOrder === "asc" ? 1 : -1;
    const [result] = await Proposal.aggregate<{ items: Row[]; total: { count: number }[] }>([ // tenant-scoped: pipelineFor starts with rfpListScope
      ...pipelineFor(actor, request),
      { $sort: { [SORT_PATHS[request.sortBy]]: direction, _id: direction } },
      {
        $facet: {
          items: [
            { $skip: (request.page - 1) * request.limit },
            { $limit: request.limit },
            {
              $project: {
                effectiveStage: 1, status: 1, isDraft: 1, userId: 1, teamId: 1,
                "event.eventName": 1, "event.startDate": 1, "event.endDate": 1,
                "venueSchedule.venueCity": 1,
                "lifecycle.vendorsInvited": 1, "lifecycle.vendorsResponded": 1,
                "lifecycle.reviewStartedAt": 1, "lifecycle.awardedAt": 1,
                createdAt: 1, updatedAt: 1,
              },
            },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);
    const rows = result?.items ?? [];

    // Display names for the page's owners and teams. The ids come from RFPs the actor may see.
    const ownerIds = [...new Set(rows.map((row) => row.userId).filter(Boolean).map(String))];
    const teamIds = [...new Set(rows.map((row) => row.teamId).filter(Boolean).map(String))];
    const [owners, teams] = await Promise.all([
      ownerIds.length ? User.find({ _id: { $in: ownerIds } }).select("name").lean<{ _id: unknown; name?: string }[]>() : [],
      teamIds.length
        ? Team.find({ organizationId: actor.organizationId, _id: { $in: teamIds } }).select("name").lean<{ _id: unknown; name?: string }[]>()
        : [],
    ]);
    const ownerName = new Map(owners.map((owner) => [String(owner._id), owner.name ?? null]));
    const teamName = new Map(teams.map((team) => [String(team._id), team.name ?? null]));

    return {
      total: result?.total[0]?.count ?? 0,
      items: rows.map((row) => ({
        id: String(row._id),
        eventName: nonEmpty(row.event?.eventName) ?? "Untitled RFP",
        stage: row.effectiveStage,
        status: row.status ?? null,
        isDraft: row.isDraft === true,
        ownerUserId: row.userId ? String(row.userId) : null,
        ownerName: row.userId ? ownerName.get(String(row.userId)) ?? null : null,
        teamId: row.teamId ? String(row.teamId) : null,
        teamName: row.teamId ? teamName.get(String(row.teamId)) ?? null : null,
        eventStartDate: nonEmpty(row.event?.startDate),
        eventEndDate: nonEmpty(row.event?.endDate),
        venueCity: nonEmpty(row.venueSchedule?.venueCity),
        vendorsInvited: row.lifecycle?.vendorsInvited ?? 0,
        vendorsResponded: row.lifecycle?.vendorsResponded ?? 0,
        reviewStartedAt: row.lifecycle?.reviewStartedAt ?? null,
        awardedAt: row.lifecycle?.awardedAt ?? null,
        createdAt: row.createdAt ?? null,
        updatedAt: row.updatedAt ?? null,
      })),
    };
  },

  async summary(actor, filters, quarter) {
    const stageIs = (stage: string) => ({ $eq: ["$effectiveStage", stage] });
    const [row] = await Proposal.aggregate<Record<string, number>>([ // tenant-scoped: pipelineFor starts with rfpListScope
      ...pipelineFor(actor, filters),
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          activeRfps: { $sum: { $cond: [{ $in: ["$effectiveStage", [...ACTIVE_STAGES]] }, 1, 0] } },
          responsesReceived: { $sum: { $ifNull: ["$lifecycle.vendorsResponded", 0] } },
          awardedThisQuarter: {
            $sum: {
              $cond: [
                { $and: [stageIs("awarded"), { $gte: ["$lifecycle.awardedAt", quarter.start] }, { $lt: ["$lifecycle.awardedAt", quarter.end] }] },
                1,
                0,
              ],
            },
          },
          ...Object.fromEntries(LIFECYCLE_STAGES.map((stage) => [`stage_${stage}`, { $sum: { $cond: [stageIs(stage), 1, 0] } }])),
        },
      },
    ]);
    const byStage = emptyByStage();
    for (const stage of LIFECYCLE_STAGES) byStage[stage] = row?.[`stage_${stage}`] ?? 0;
    return {
      total: row?.total ?? 0,
      activeRfps: row?.activeRfps ?? 0,
      responsesReceived: row?.responsesReceived ?? 0,
      awardedThisQuarter: row?.awardedThisQuarter ?? 0,
      byStage,
    };
  },
};
