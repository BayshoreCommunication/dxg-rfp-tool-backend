import type mongoose from "mongoose";
import EmailCampaign from "../../../../../modal/emailModel";
import Proposal from "../../../../../modal/proposalsModel";

/* Per-account usage numbers for the staff client list and the admin overview (owner decision,
   2026-11-17: staff see counts without a support grant, never customer content). Each is its own
   grouped query that names the organization in its filter, so what an account owns in any other
   organization is not counted, and a row with no organizationId is not counted either. Only
   owner ids and numbers leave the database: no proposal or campaign document is loaded. Both
   are served by the { organizationId, userId, createdAt } indexes. */

export const proposalCountPipeline = (
  organizationId: mongoose.Types.ObjectId,
  userIds: readonly unknown[],
) => [
  { $match: { organizationId, userId: { $in: [...userIds] } } },
  { $group: { _id: "$userId", count: { $sum: 1 } } },
];

export const emailSentPipeline = (
  organizationId: mongoose.Types.ObjectId,
  userIds: readonly unknown[],
) => [
  { $match: { organizationId, userId: { $in: [...userIds] } } },
  { $group: { _id: "$userId", totalEmailSent: { $sum: "$sentCount" } } },
];

export type AccountUsage = { totalProposals: number; totalEmailSent: number };

/** Usage for the given accounts inside one organization; an account with nothing there reads 0. */
export const accountUsage = async (
  organizationId: mongoose.Types.ObjectId,
  userIds: readonly unknown[],
): Promise<(userId: unknown) => AccountUsage> => {
  if (userIds.length === 0) return () => ({ totalProposals: 0, totalEmailSent: 0 });
  // No type argument on the Proposal call: the tenant scope guard only matches an untyped call.
  const [proposals, emails]: [Array<{ _id: unknown; count: number }>, Array<{ _id: unknown; totalEmailSent: number }>] =
    await Promise.all([
      Proposal.aggregate(proposalCountPipeline(organizationId, userIds)),
      EmailCampaign.aggregate(emailSentPipeline(organizationId, userIds)),
    ]);
  const proposalsByOwner = new Map(proposals.map((row) => [String(row._id), row.count]));
  const emailsByOwner = new Map(emails.map((row) => [String(row._id), row.totalEmailSent]));
  return (userId) => ({
    totalProposals: proposalsByOwner.get(String(userId)) ?? 0,
    totalEmailSent: emailsByOwner.get(String(userId)) ?? 0,
  });
};
