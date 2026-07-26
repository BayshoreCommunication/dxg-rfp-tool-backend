import User from "../../../../../modal/userModel";
import type { AdminClientRepository } from "../../domain/ports/adminClientRepository";
import { tenantFilter, tenantObjectId } from "../../../shared/tenancy/tenantContext";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const mongoAdminClientRepository: AdminClientRepository = {
  async list({ page, perPage, search }) {
    const matchStage: Record<string, unknown> = {
      organizationId: tenantObjectId(),
      role: { $nin: ["admin", "super_admin", "superadmin"] },
    };
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      matchStage.$or = [{ name: regex }, { email: regex }];
    }
    const [result] = await User.aggregate<{
      metadata: { total: number }[];
      data: Record<string, unknown>[];
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
                from: "proposals",
                let: { userId: "$_id" },
                pipeline: [
                  { $match: { $expr: { $eq: ["$userId", "$$userId"] } } },
                  { $count: "count" },
                ],
                as: "proposalStats",
              },
            },
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
                totalProposals: { $ifNull: [{ $first: "$proposalStats.count" }, 0] },
                totalEmailSent: { $ifNull: [{ $first: "$emailStats.totalEmailSent" }, 0] },
              },
            },
          ],
        },
      },
    ]);
    return {
      clients: result?.data ?? [],
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
