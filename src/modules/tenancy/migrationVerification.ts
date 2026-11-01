import mongoose from "mongoose";
import type { Pool } from "pg";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import Proposal from "../../../modal/proposalsModel";
import User from "../../../modal/userModel";
import VendorResponse from "../../../modal/vendorResponseModel";
import { rfpListScope } from "../identity/domain/rfpAccessPolicy";
import { resolveRfpActor } from "../identity/application/resolveRfpActor";
import { STAFF_ROLES } from "./customerOrganizationMigration";
import { STAY_TABLES } from "./postgresTenantMove";

// ORG-109: proves the customer organization migration (ORG-107) lost nobody's access. Three checks:
// every customer sees exactly what they saw before, nothing customer-owned is left in the shared
// organization, and every proposal's owner is an active member of its organization.

export type UserVisibility = { userId: string; organizationId: string; proposals: string[]; vendorResponses: string[] };
export type VisibilitySnapshot = { takenAt: string; users: UserVisibility[] };

const sorted = (values: unknown[]) => values.map(String).sort();

// What each active member can see, through the same access-policy scope the app uses.
export const snapshotVisibility = async (): Promise<VisibilitySnapshot> => {
  const memberships = await OrganizationMembership.collection
    .find({ status: "active" }, { projection: { organizationId: 1, userId: 1, roles: 1, status: 1 } })
    .toArray();
  const users: UserVisibility[] = [];
  for (const membership of memberships) {
    const actor = await resolveRfpActor({
      organizationId: String(membership.organizationId),
      userId: String(membership.userId),
      roles: (membership.roles as string[]) ?? [],
      status: String(membership.status),
    });
    const proposalIds = (await Proposal.collection.find(rfpListScope(actor, "view"), { projection: { _id: 1 } }).toArray()).map((p) => p._id);
    const responses = await VendorResponse.collection
      .find({ organizationId: membership.organizationId, proposalId: { $in: proposalIds } }, { projection: { _id: 1 } })
      .toArray();
    users.push({
      userId: String(membership.userId),
      organizationId: String(membership.organizationId),
      proposals: sorted(proposalIds),
      vendorResponses: sorted(responses.map((r) => r._id)),
    });
  }
  return { takenAt: new Date().toISOString(), users: users.sort((a, b) => a.userId.localeCompare(b.userId)) };
};

export type VisibilityDifference = { userId: string; lostProposals: string[]; gainedProposals: string[]; lostVendorResponses: string[]; gainedVendorResponses: string[] };

// Per user, by user id (a migrated customer's organization changes; what they see must not).
// A user who was in the snapshot and has no active membership now has lost everything.
export const compareVisibility = (before: VisibilitySnapshot, after: VisibilitySnapshot): VisibilityDifference[] => {
  const now = new Map(after.users.map((u) => [u.userId, u]));
  const differences: VisibilityDifference[] = [];
  for (const previous of before.users) {
    const current = now.get(previous.userId) ?? { proposals: [], vendorResponses: [] };
    const diff = (a: string[], b: string[]) => a.filter((id) => !new Set(b).has(id));
    const difference = {
      userId: previous.userId,
      lostProposals: diff(previous.proposals, current.proposals),
      gainedProposals: diff(current.proposals, previous.proposals),
      lostVendorResponses: diff(previous.vendorResponses, current.vendorResponses),
      gainedVendorResponses: diff(current.vendorResponses, previous.vendorResponses),
    };
    if (Object.values(difference).some((v) => Array.isArray(v) && v.length > 0)) differences.push(difference);
  }
  return differences;
};

// Customer-owned records still in the shared organization. DXG staff records and DXG's corpus
// legitimately stay; anything else counted here was missed by the migration.
export const findCustomerLeftovers = async (input: { organizationId: string; pool: Pool | null }) => {
  const organizationId = new mongoose.Types.ObjectId(input.organizationId);
  const staff = await User.collection
    .find({ organizationId, role: { $in: [...STAFF_ROLES] } }, { projection: { _id: 1 } })
    .toArray();
  const staffIds = staff.map((s) => s._id);
  const staffTickets = (await mongoose.connection.collection("supporttickets")
    .find({ organizationId, requesterUserId: { $in: staffIds } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
  const notStaff = { $nin: staffIds };
  const mongoFilters: Record<string, Record<string, unknown>> = {
    users: { _id: notStaff },
    organizationmemberships: { userId: notStaff },
    proposals: {}, settings: { userId: notStaff }, emailcampaigns: { userId: notStaff },
    notifications: { userId: notStaff }, refreshsessions: { userId: notStaff },
    supporttickets: { requesterUserId: notStaff },
    supportmessages: { ticketId: { $nin: staffTickets } }, supportattachments: { ticketId: { $nin: staffTickets } },
    vendorresponses: {}, vendorsubmissions: {}, vendorsubmissionversions: {}, vendorsubmissiondrafts: {},
    vendorconfirmationdeliveries: {}, vendorresponsequestionnaireversions: {},
    proposalcanonicalsnapshots: {}, publicaccessgrants: {},
  };
  const mongo: Record<string, number> = {};
  for (const [name, filter] of Object.entries(mongoFilters)) {
    const n = await mongoose.connection.collection(name).countDocuments({ ...filter, organizationId });
    if (n) mongo[name] = n;
  }

  const postgres: Record<string, number> = {};
  if (input.pool) {
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      // Read every organization's rows, as the migration does; the transaction is read only.
      const pg = (await client.query<{ id: string }>(
        "SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1", [input.organizationId],
      )).rows[0]?.id;
      if (pg) {
        await client.query("SELECT set_config('app.organization_id',$1,true), set_config('app.organization_mongo_id',$2,true)", [pg, input.organizationId]);
        const staffMongoIds = staffIds.map(String);
        const tables = (await client.query<{ name: string }>(
          `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
            WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' ORDER BY 1`,
        )).rows.map((r) => r.name).filter((name) => !STAY_TABLES.has(name));
        for (const name of tables) {
          const staffOwned = name === "users"
            ? " AND NOT (external_mongo_id = ANY($2))"
            : name === "audit_events" ? " AND actor_external_user_id IS NOT NULL AND NOT (actor_external_user_id = ANY($2))" : "";
          const params = staffOwned ? [pg, staffMongoIds] : [pg];
          const n = Number((await client.query(`SELECT count(*) FROM rfpilot."${name}" WHERE organization_id = $1${staffOwned}`, params)).rows[0].count);
          if (n) postgres[name] = n;
        }
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
  return { mongo, postgres };
};

// Proposals whose owner has no active membership in the proposal's organization. Run after the
// migration and nightly (PRD metric "orphaned RFPs = 0").
export const findOrphanedProposals = async (input: { sampleSize?: number } = {}) => {
  const rows = await Proposal.collection.aggregate<{ _id: unknown; count: number; sample: unknown[] }>([
    { $match: { userId: { $ne: null } } },
    {
      $lookup: {
        from: OrganizationMembership.collection.collectionName,
        let: { organizationId: "$organizationId", userId: "$userId" },
        pipeline: [{ $match: { $expr: { $and: [
          { $eq: ["$organizationId", "$$organizationId"] }, { $eq: ["$userId", "$$userId"] }, { $eq: ["$status", "active"] },
        ] } } }, { $limit: 1 }],
        as: "owner",
      },
    },
    { $match: { owner: { $size: 0 } } },
    { $group: { _id: "$organizationId", count: { $sum: 1 }, sample: { $push: "$_id" } } },
  ]).toArray();
  const sampleSize = input.sampleSize ?? 20;
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    byOrganization: rows.map((row) => ({ organizationId: String(row._id), count: row.count, sample: row.sample.slice(0, sampleSize).map(String) })),
  };
};
