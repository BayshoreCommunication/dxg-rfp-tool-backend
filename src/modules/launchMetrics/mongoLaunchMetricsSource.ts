import mongoose from "mongoose";
import Invitation from "../../../modal/invitationModel";
import Organization from "../../../modal/organizationModel";
import OrganizationMembership, { CUSTOMER_ORGANIZATION_ROLES } from "../../../modal/organizationMembershipModel";
import SecurityAuditEvent from "../../../modal/securityAuditEventModel";
import SupportAccessGrant from "../../../modal/supportAccessGrantModel";
import { SUPPORT_AUDIT } from "../supportAccess/domain";
import { findOrphanedProposals } from "../tenancy/migrationVerification";
import type { LaunchMetricsSource } from "./domain";

// ORG-505. These queries deliberately read across every organization: they are reachable only
// from the staff-only launch metrics endpoint and the operator report script, and each projects
// dates and counts only, so no customer's data leaves its organization.
export const mongoLaunchMetricsSource: LaunchMetricsSource = {
  async invitations(since, until) {
    const rows = await Invitation.find({ createdAt: { $gte: since, $lte: until } }).select("createdAt acceptedAt -_id").lean();
    return rows.map((row) => ({ createdAt: row.createdAt, acceptedAt: row.acceptedAt ?? null }));
  },

  async acceptances(since, until) {
    return Invitation.aggregate<{ acceptedAt: Date; firstRfpOpenedAt: Date | null }>([
      { $match: { status: "accepted", acceptedBy: { $ne: null }, acceptedAt: { $gte: since, $lte: until } } },
      // Someone removed and invited again has two acceptances; the latest one is the current membership.
      { $group: { _id: { organizationId: "$organizationId", userId: "$acceptedBy" }, acceptedAt: { $max: "$acceptedAt" } } },
      {
        $lookup: {
          from: OrganizationMembership.collection.collectionName,
          let: { organizationId: "$_id.organizationId", userId: "$_id.userId" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$organizationId", "$$organizationId"] }, { $eq: ["$userId", "$$userId"] }] } } },
            { $limit: 1 },
            { $project: { _id: 0, firstRfpOpenedAt: 1 } },
          ],
          as: "membership",
        },
      },
      { $project: { _id: 0, acceptedAt: 1, firstRfpOpenedAt: { $ifNull: [{ $first: "$membership.firstRfpOpenedAt" }, null] } } },
    ]);
  },

  // Staff accounts hold only legacy DXG roles, so DXG's own organization counts only if it still
  // holds customers. Legacy holding tenants are one parked user each, not organizations.
  async activeMemberCounts() {
    const rows = await OrganizationMembership.aggregate<{ members: number }>([
      { $match: { status: "active", roles: { $in: [...CUSTOMER_ORGANIZATION_ROLES] } } },
      { $group: { _id: "$organizationId", members: { $sum: 1 } } },
      {
        $lookup: {
          from: Organization.collection.collectionName,
          let: { organizationId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$organizationId"] }, status: "active", kind: { $ne: "legacy_holding" } } },
            { $project: { _id: 1 } },
          ],
          as: "organization",
        },
      },
      { $match: { organization: { $ne: [] } } },
      { $project: { _id: 0, members: 1 } },
    ]);
    return rows.map((row) => row.members);
  },

  async supportReads(since, until) {
    const events = await SecurityAuditEvent.find({ action: SUPPORT_AUDIT.used, createdAt: { $gte: since, $lte: until } })
      .select("organizationId createdAt targetType targetId metadata.grantId -_id")
      .lean();
    const grantIds = [...new Set(events.map((event) => String(event.metadata?.grantId ?? "")).filter((id) => mongoose.isValidObjectId(id)))];
    // scope-exempt: platform launch metrics; each grant is matched to its event's organization below, and only its dates are read
    const grants = await SupportAccessGrant.find({ _id: { $in: grantIds } }).select("createdAt expiresAt revokedAt organizationId proposalId").lean();
    const byId = new Map(grants.map((grant) => [String(grant._id), grant]));
    return events.map((event) => {
      const grant = byId.get(String(event.metadata?.grantId ?? ""));
      const sameOrganization = grant && String(grant.organizationId) === String(event.organizationId);
      // An RFP-scoped grant covers only that RFP; an organization-wide one covers any target.
      const covers = grant && (!grant.proposalId || (event.targetType === "proposal" && String(grant.proposalId) === String(event.targetId)));
      return {
        at: event.createdAt,
        grant: grant && sameOrganization && covers ? { createdAt: grant.createdAt, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt ?? null } : null,
      };
    });
  },

  supportRefusals: (since, until) =>
    SecurityAuditEvent.countDocuments({ action: SUPPORT_AUDIT.denied, reason: "no_active_grant", createdAt: { $gte: since, $lte: until } }),

  async firstOpenTrackingSince() {
    const earliest = await OrganizationMembership.findOne({ firstRfpOpenedAt: { $ne: null } }).sort({ firstRfpOpenedAt: 1 }).select("firstRfpOpenedAt -_id").lean();
    return earliest?.firstRfpOpenedAt ?? null;
  },

  // The ORG-109 check the nightly job runs: RFPs whose owner is not an active member.
  async orphanedRfps() {
    const result = await findOrphanedProposals({ sampleSize: 0 });
    return { total: result.total, organizations: result.byOrganization.length };
  },
};
