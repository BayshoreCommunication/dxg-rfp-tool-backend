import mongoose from "mongoose";
import type { Pool } from "pg";
import Organization from "../../../modal/organizationModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import Proposal from "../../../modal/proposalsModel";
import User from "../../../modal/userModel";
import VendorResponse from "../../../modal/vendorResponseModel";
import { rfpListScope } from "../identity/domain/rfpAccessPolicy";
import { resolveRfpActor } from "../identity/application/resolveRfpActor";
import { mongoActorLookups } from "../identity/application/mongoActorLookups";
import { STAFF_ROLES } from "./customerOrganizationMigration";
import { STAY_TABLES, findCrossOwnerCompositeTies, loadTenantSchema, plainParentEdges, type CrossOwnerTies, type TenantSchema } from "./postgresTenantMove";

// ORG-109: proves the customer organization migration (ORG-107) lost nobody's access. Four checks:
// every customer sees exactly what they saw before, nothing customer-owned is left in the shared
// organization, every proposal's owner is an active member of its organization, and every
// proposal's Postgres data is in the proposal's organization.

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
    }, mongoActorLookups);
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
      // Row-level security is forced on rfpilot.organizations too, so the role production runs
      // this as (the table owner, no superuser) sees no organization until it names one. Without
      // this the lookup found nothing and the whole Postgres check passed without looking (ORG-501).
      await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [input.organizationId]);
      const pg = (await client.query<{ id: string }>(
        "SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1", [input.organizationId],
      )).rows[0]?.id;
      if (pg) {
        await client.query("SELECT set_config('app.organization_id',$1,true)", [pg]);
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

export type MisplacedProposalData = {
  // What the check read. A run that read no organization or no reference proved nothing.
  checked: { organizations: number; references: number; proposals: number };
  // Why the check proved nothing, when it read nothing it could judge; null when it read.
  notRead: string | null;
  total: number;
  // A proposal's reference row is in a different organization than the proposal (MongoDB).
  referenceNotWithProposal: Array<{ proposalId: string; proposalOrganizationId: string | null; referenceOrganizationId: string }>;
  // A reference's owner (rfpilot.users) is in a different organization than the reference; null
  // when the owner's row is in no organization MongoDB knows.
  ownerNotWithReference: Array<{ proposalId: string; referenceOrganizationId: string; ownerOrganizationId: string | null }>;
  // Rows whose parent, by a plain foreign key, is not in their own organization: a message apart
  // from its conversation, a job apart from its reference, and so on down every chain.
  rowsNotWithParent: Array<{ organizationId: string; table: string; parent: string; rows: number }>;
};

type ReferencePlacement = {
  organizationsRead: number;
  references: Array<{ proposalId: string; ownerUserId: string; organizationId: string }>;
  // rfpilot.users id -> the organization (MongoDB id) its row is in.
  userOrganization: Map<string, string>;
  rowsNotWithParent: MisplacedProposalData["rowsNotWithParent"];
};

// The plain foreign keys whose two ends must be in one organization. Composite keys can't be
// split (the database refuses), parents in STAY_TABLES are DXG's shared corpus, and a reference
// apart from its owner is reported by proposal id instead.
export const parentEdgesToCheck = (schema: TenantSchema) =>
  plainParentEdges(schema).filter((edge) => !(edge.child === "proposal_references" && edge.parent === "users"));

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

// Where every proposal reference and every users row is, and which rows are apart from a parent,
// read one organization at a time. Tenant tables force row-level security, so the table owner
// sees no row until the session names an organization, the way findCustomerLeftovers names one.
// That is also how a split is found: a child in this organization whose parent is not found in
// this organization. Every query also filters on the organization, so a superuser (who bypasses
// the policies) reads the same.
export const readReferencePlacement = async (input: { pool: Pool; organizationIds: string[] }): Promise<ReferencePlacement> => {
  const placement: ReferencePlacement = { organizationsRead: 0, references: [], userOrganization: new Map(), rowsNotWithParent: [] };
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const edges = parentEdgesToCheck(await loadTenantSchema(client));
    for (const organizationId of input.organizationIds) {
      await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationId]);
      const pg = (await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1", [organizationId])).rows[0]?.id;
      if (!pg) continue;
      placement.organizationsRead += 1;
      await client.query("SELECT set_config('app.organization_id',$1,true)", [pg]);
      for (const row of (await client.query<{ id: string }>("SELECT id FROM rfpilot.users WHERE organization_id = $1", [pg])).rows) placement.userOrganization.set(row.id, organizationId);
      const references = await client.query<{ external_mongo_id: string; owner_user_id: string }>(
        "SELECT external_mongo_id, owner_user_id FROM rfpilot.proposal_references WHERE organization_id = $1", [pg],
      );
      for (const row of references.rows) placement.references.push({ proposalId: row.external_mongo_id, ownerUserId: row.owner_user_id, organizationId });
      if (edges.length) {
        const apart = await client.query<{ edge: number; rows: string }>(
          edges.map((edge, i) => `SELECT ${i}::int AS edge, count(*) AS rows FROM rfpilot.${quoted(edge.child)} child
             WHERE child.organization_id = $1 AND ${edge.childColumns.map((column) => `child.${quoted(column)} IS NOT NULL`).join(" AND ")}
               AND NOT EXISTS (SELECT 1 FROM rfpilot.${quoted(edge.parent)} parent WHERE parent.organization_id = $1
                 AND ${edge.childColumns.map((column, k) => `parent.${quoted(edge.parentColumns[k])} = child.${quoted(column)}`).join(" AND ")})`).join(" UNION ALL "),
          [pg],
        );
        for (const row of apart.rows) {
          if (Number(row.rows)) placement.rowsNotWithParent.push({ organizationId, table: edges[row.edge].child, parent: edges[row.edge].parent, rows: Number(row.rows) });
        }
      }
    }
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return placement;
};

// proposalOrganization: for each proposal that exists in MongoDB, the organization it is in.
// mongoProposals: how many proposals MongoDB holds in all.
export const compareReferencePlacement = (
  placement: ReferencePlacement, proposalOrganization: Map<string, string | null>, options: { mongoProposals: number; sampleSize?: number },
): MisplacedProposalData => {
  const referenceNotWithProposal: MisplacedProposalData["referenceNotWithProposal"] = [];
  const ownerNotWithReference: MisplacedProposalData["ownerNotWithReference"] = [];
  for (const reference of placement.references) {
    // A reference whose proposal was deleted from MongoDB has nothing to be compared with.
    if (proposalOrganization.has(reference.proposalId) && proposalOrganization.get(reference.proposalId) !== reference.organizationId) {
      referenceNotWithProposal.push({ proposalId: reference.proposalId, proposalOrganizationId: proposalOrganization.get(reference.proposalId) ?? null, referenceOrganizationId: reference.organizationId });
    }
    const ownerOrganizationId = placement.userOrganization.get(reference.ownerUserId) ?? null;
    if (ownerOrganizationId !== reference.organizationId) {
      ownerNotWithReference.push({ proposalId: reference.proposalId, referenceOrganizationId: reference.organizationId, ownerOrganizationId });
    }
  }
  // Reading nothing is not passing: the wrong database, or a role the policies hide every row from.
  const notRead = placement.organizationsRead === 0
    ? "no organization known to MongoDB was found in Postgres, so nothing was read"
    : placement.references.length === 0 && options.mongoProposals > 0
      ? `no proposal reference was read in Postgres although MongoDB holds ${options.mongoProposals} proposals`
      : null;
  const sampleSize = options.sampleSize ?? 50;
  return {
    checked: { organizations: placement.organizationsRead, references: placement.references.length, proposals: proposalOrganization.size },
    notRead,
    total: referenceNotWithProposal.length + ownerNotWithReference.length + placement.rowsNotWithParent.reduce((sum, row) => sum + row.rows, 0),
    referenceNotWithProposal: referenceNotWithProposal.slice(0, sampleSize),
    ownerNotWithReference: ownerNotWithReference.slice(0, sampleSize),
    rowsNotWithParent: placement.rowsNotWithParent.slice(0, sampleSize),
  };
};

// A proposal's Postgres data follows the proposal (DECISIONS.md, 2026-11-23): the reference row
// sits in the proposal's organization, with its owner, and every row is with the parent it hangs
// off. The migration once put one customer's reference and AI data in another customer's holding
// tenant, and no other check saw it: visibility reads MongoDB, and the owner foreign key is one
// column. Organization ids in the result are MongoDB ids. Lists are capped at sampleSize; total
// is not.
export const findMisplacedProposalData = async (input: { pool: Pool; sampleSize?: number }): Promise<MisplacedProposalData> => {
  const organizationIds = (await Organization.collection.find({}, { projection: { _id: 1 } }).toArray()).map((o) => String(o._id));
  const placement = await readReferencePlacement({ pool: input.pool, organizationIds });
  const proposalOrganization = new Map<string, string | null>();
  const ids = [...new Set(placement.references.map((r) => r.proposalId))];
  for (let i = 0; i < ids.length; i += 5000) {
    const found = await Proposal.collection
      .find({ _id: { $in: ids.slice(i, i + 5000).map((id) => new mongoose.Types.ObjectId(id)) } }, { projection: { organizationId: 1 } })
      .toArray();
    for (const proposal of found) proposalOrganization.set(String(proposal._id), proposal.organizationId ? String(proposal.organizationId) : null);
  }
  return compareReferencePlacement(placement, proposalOrganization, { mongoProposals: await Proposal.collection.estimatedDocumentCount(), sampleSize: input.sampleSize });
};

// Pre-flight, read before the apply: rows in one organization (the shared one) that hang off two
// owners' references. null when the organization has no row in Postgres. See
// findCrossOwnerCompositeTies in postgresTenantMove.ts. The transaction is always rolled back; it
// is not READ ONLY only because Postgres refuses to create the temporary work table in one.
export const findCrossOwnerTies = async (input: { pool: Pool; organizationId: string; sampleSize?: number }): Promise<CrossOwnerTies | null> => {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [input.organizationId]);
    const pg = (await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1", [input.organizationId])).rows[0]?.id;
    let ties: CrossOwnerTies | null = null;
    if (pg) {
      await client.query("SELECT set_config('app.organization_id',$1,true)", [pg]);
      ties = await findCrossOwnerCompositeTies(client, await loadTenantSchema(client), { organizationId: pg, sampleSize: input.sampleSize });
    }
    await client.query("ROLLBACK");
    return ties;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

type Leftovers = { mongo: Record<string, number>; postgres: Record<string, number> };
// The verifier's verdict, one entry per check: true, false, or why it was skipped. Any false
// fails the run (exit 1).
export const verificationChecks = (input: {
  visibility: VisibilityDifference[] | null; leftovers: Leftovers; orphans: { total: number }; misplaced: Pick<MisplacedProposalData, "total" | "notRead"> | null;
}) => ({
  visibilityUnchanged: input.visibility === null ? "skipped: pass --before=<snapshot>" : input.visibility.length === 0,
  noCustomerRecordsInSharedOrganization: Object.keys(input.leftovers.mongo).length === 0 && Object.keys(input.leftovers.postgres).length === 0,
  everyProposalHasAnActiveOwner: input.orphans.total === 0,
  proposalDataFollowsProposal: input.misplaced === null ? "skipped: no Postgres connection" : input.misplaced.total === 0 && input.misplaced.notRead === null,
});
export const verificationFailed = (checks: Record<string, boolean | string>) => Object.values(checks).some((ok) => ok === false);

// Proposals whose owner has no active membership in the proposal's organization. Run after the
// migration and nightly (PRD metric "orphaned RFPs = 0").
// organizationId narrows the scan to one organization (ORG-110 checks only its target).
export const findOrphanedProposals = async (input: { sampleSize?: number; organizationId?: string } = {}) => {
  const rows = await Proposal.collection.aggregate<{ _id: unknown; count: number; sample: unknown[] }>([
    { $match: { userId: { $ne: null }, ...(input.organizationId ? { organizationId: new mongoose.Types.ObjectId(input.organizationId) } : {}) } },
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
