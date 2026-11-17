import type mongoose from "mongoose";
import Proposal from "../../../../../modal/proposalsModel";
import User from "../../../../../modal/userModel";
import type { AdminClientRepository } from "../../domain/ports/adminClientRepository";
import { tenantFilter, tenantObjectId } from "../../../shared/tenancy/tenantContext";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* The per-account proposal count on the staff client list (owner decision, 2026-11-17: staff see
   counts without a support grant, never proposal content). It is its own query on Proposal so
   the tenant is named in the filter, where tests/tenant-scope-guard.test.js can see it: an
   account's proposals in any other organization are not counted. Only the owner id and a number
   leave the database; no proposal document is loaded. Served by the
   { organizationId, userId, createdAt } index. */
export const proposalCountPipeline = (
  organizationId: mongoose.Types.ObjectId,
  userIds: readonly unknown[],
) => [
  { $match: { organizationId, userId: { $in: [...userIds] } } },
  { $group: { _id: "$userId", count: { $sum: 1 } } },
];

export const mongoAdminClientRepository: AdminClientRepository = {
  async list({ page, perPage, search }) {
    const organizationId = tenantObjectId();
    const matchStage: Record<string, unknown> = {
      organizationId,
      role: { $nin: ["admin", "super_admin", "superadmin"] },
    };
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      matchStage.$or = [{ name: regex }, { email: regex }];
    }
    const [result] = await User.aggregate<{
      metadata: { total: number }[];
      data: Array<Record<string, unknown> & { id: unknown }>;
    }>([
      { $match: matchStage },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $sort: { createdAt: -1 } },
            { $skip: (page - 1) * perPage },
            { $limit: perPage },
            {
              $lookup: {
                from: "emailcampaigns",
                let: { userId: "$_id" },
                pipeline: [
                  { $match: { $expr: { $eq: ["$userId", "$$userId"] } } },
                  { $group: { _id: null, totalEmailSent: { $sum: "$sentCount" } } },
                ],
                as: "emailStats",
              },
            },
            {
              $project: {
                _id: 0,
                id: "$_id",
                name: 1,
                email: 1,
                company: { $ifNull: ["$company", null] },
                joinDate: "$createdAt",
                isBlocked: { $ifNull: ["$isBlocked", false] },
                totalEmailSent: { $ifNull: [{ $first: "$emailStats.totalEmailSent" }, 0] },
              },
            },
          ],
        },
      },
    ]);
    const rows = result?.data ?? [];
    // No type argument on this call: the tenant scope guard only matches an untyped call.
    const counts: Array<{ _id: unknown; count: number }> = rows.length
      ? await Proposal.aggregate(proposalCountPipeline(organizationId, rows.map((row) => row.id)))
      : [];
    const proposalsByOwner = new Map(counts.map((entry) => [String(entry._id), entry.count]));
    return {
      clients: rows.map((row) => ({ ...row, totalProposals: proposalsByOwner.get(String(row.id)) ?? 0 })),
      total: result?.metadata?.[0]?.total ?? 0,
    };
  },
  async findById(id) {
    const user = await User.findOne({ _id: id, ...tenantFilter() }).select("role isBlocked").lean();
    return user ? { id: String(user._id), role: user.role, isBlocked: user.isBlocked } : null;
  },
  async setBlocked(id, isBlocked) {
    const user = await User.findOneAndUpdate(
      { _id: id, ...tenantFilter() },
      { $set: { isBlocked } },
      { new: true, runValidators: true },
    ).select("role isBlocked").lean();
    if (!user) throw new Error("Admin client disappeared during update");
    return { id: String(user._id), role: user.role, isBlocked: user.isBlocked };
  },
  async deleteById(id) {
    await User.deleteOne({ _id: id, ...tenantFilter() });
  },
};
