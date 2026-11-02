import crypto from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import type { Pool } from "pg";
import Organization, { ORGANIZATION_TYPES } from "../../../modal/organizationModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import Proposal from "../../../modal/proposalsModel";
import SecurityAuditEvent from "../../../modal/securityAuditEventModel";
import User from "../../../modal/userModel";
import { inPostgres, moveCustomer, postgresOrganizationId } from "./customerOrganizationMigration";
import { moveCustomerDocuments, type MongoMoveCounts } from "./mongoTenantMove";
import { moveCustomerRows, type MoveCounts } from "./postgresTenantMove";
import { findCustomerLeftovers, findOrphanedProposals } from "./migrationVerification";

// ORG-110: a DXG admin places a legacy customer (ORG-107 moved each one into a holding tenant of
// their own) into a real organization: a new one, where they become Owner, or an existing one,
// with a role other than Owner or Viewer. The holding tenant's MongoDB and Postgres records move
// with ORG-107's rewrite as one journaled run; the run rolls back by id. The holding tenant is
// retired, audit events go to the target organization and the admin's own trail, and ORG-109's
// checks run after every run.

const JOURNAL = "legacycustomerplacements";
export const PLACEMENT_ROLES = ["organization_admin", "team_manager", "planner"] as const;
export type PlacementRole = (typeof PLACEMENT_ROLES)[number] | "owner";

export type NewOrganizationDetails = {
  name: string; type?: string | null; industry?: string | null; country?: string | null;
  timeZone?: string | null; eventsPerYear?: number | null;
};
export type PlacementTarget =
  | { kind: "new"; organization: NewOrganizationDetails }
  | { kind: "existing"; organizationId: string; role: string; teamId?: string | null };

type JournalEntry = {
  runId: string; userId: string; holdingOrganizationId: string; targetOrganizationId: string;
  createdOrganization: boolean; role: PlacementRole; state: "started" | "done" | "failed" | "rolled_back";
  adminUserId: string; adminOrganizationId: string; error?: string;
  previousVersion?: number | null; mongo?: MongoMoveCounts; postgres?: MoveCounts | Record<string, never>;
  verification?: PlacementVerification; createdAt: Date; updatedAt: Date;
};

export type PlacementVerification = {
  passed: boolean;
  holdingLeftovers: { mongo: Record<string, number>; postgres: Record<string, number> };
  orphanedProposalsInTarget: number;
  lostProposals: string[];
};

export class PlacementError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 503 = 409) { super(message); }
}

export type PlacementActor = { adminUserId: string; adminOrganizationId: string; correlationId: string };

const journal = () => mongoose.connection.collection<JournalEntry>(JOURNAL);
const objectId = (value: string) => new mongoose.Types.ObjectId(value);
const isObjectId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const safeError = (error: unknown) => (error instanceof Error ? error.message : "Placement step failed").slice(0, 300);

const slugFor = (name: string) => {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "organization";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
};

// The holding tenant a legacy customer is still in, if any.
const holdingOf = async (userId: string) => {
  const memberships = await OrganizationMembership.find({ userId: objectId(userId), status: "active" }).select("organizationId version").lean();
  if (memberships.length === 0) return null;
  const holding = await Organization.findOne({ _id: { $in: memberships.map((m) => m.organizationId) }, kind: "legacy_holding", status: "active" })
    .select("_id name").lean();
  if (!holding) return null;
  const membership = memberships.find((m) => String(m.organizationId) === String(holding._id))!;
  return { organizationId: String(holding._id), name: holding.name, version: Number(membership.version ?? 1) };
};

// Legacy customers still in a holding tenant, with how many proposals they own there.
export const listUnplacedLegacyCustomers = async () => {
  const holdings = await Organization.find({ kind: "legacy_holding", status: "active" }).select("_id createdAt").lean();
  const holdingIds = holdings.map((h) => h._id);
  const memberships = await OrganizationMembership.find({ organizationId: { $in: holdingIds }, status: "active" }).select("organizationId userId").lean();
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select("name email company createdAt").lean();
  const counts = await Proposal.aggregate<{ _id: unknown; count: number }>([
    // tenant-scoped: an admin report across holding tenants, keyed by organizationId
    { $match: { organizationId: { $in: holdingIds } } },
    { $group: { _id: "$organizationId", count: { $sum: 1 } } },
  ]);
  const proposalCount = new Map(counts.map((c) => [String(c._id), c.count]));
  const userById = new Map(users.map((u) => [String(u._id), u]));
  return memberships
    .map((m) => {
      const user = userById.get(String(m.userId));
      return {
        userId: String(m.userId),
        name: user?.name ?? null,
        email: user?.email ?? null,
        company: (user as { company?: string } | undefined)?.company ?? null,
        holdingOrganizationId: String(m.organizationId),
        proposalCount: proposalCount.get(String(m.organizationId)) ?? 0,
      };
    })
    .sort((a, b) => b.proposalCount - a.proposalCount || (a.email ?? "").localeCompare(b.email ?? ""));
};

// Customer organizations a legacy customer can join (the "existing organization" picker).
export const listTargetOrganizations = async (input: { q?: string; limit?: number } = {}) => {
  const q = input.q?.trim();
  const filter: Record<string, unknown> = { kind: "customer", status: "active" };
  if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const orgs = await Organization.find(filter).select("_id name slug createdAt").sort({ name: 1 }).limit(Math.min(input.limit ?? 50, 200)).lean();
  return orgs.map((o) => ({ organizationId: String(o._id), name: o.name, slug: o.slug }));
};

const validateNewOrganization = (details: NewOrganizationDetails | undefined): NewOrganizationDetails => {
  const name = typeof details?.name === "string" ? details.name.trim() : "";
  if (!name || name.length > 200) throw new PlacementError("ORGANIZATION_NAME_REQUIRED", "Enter the new organization's name (up to 200 characters).", 400);
  if (details?.type != null && !(ORGANIZATION_TYPES as readonly string[]).includes(details.type)) {
    throw new PlacementError("INVALID_ORGANIZATION_TYPE", "Unknown organization type.", 400);
  }
  return {
    name, type: details?.type ?? null, industry: details?.industry ?? null, country: details?.country ?? null,
    timeZone: details?.timeZone ?? null, eventsPerYear: details?.eventsPerYear ?? null,
  };
};

const verify = async (input: { userId: string; holdingOrganizationId: string; targetOrganizationId: string; before: string[]; pool: Pool | null }): Promise<PlacementVerification> => {
  const holdingLeftovers = await findCustomerLeftovers({ organizationId: input.holdingOrganizationId, pool: input.pool });
  const orphans = await findOrphanedProposals({ sampleSize: 0 });
  const orphanedProposalsInTarget = orphans.byOrganization.find((o) => o.organizationId === input.targetOrganizationId)?.count ?? 0;
  // The customer still owns every proposal they owned in the holding tenant.
  const owned = new Set((await Proposal.find({ organizationId: objectId(input.targetOrganizationId), userId: objectId(input.userId) }).select("_id").lean()).map((p) => String(p._id)));
  const lostProposals = input.before.filter((id) => !owned.has(id));
  const empty = (counts: Record<string, number>) => Object.keys(counts).length === 0;
  return {
    passed: empty(holdingLeftovers.mongo) && empty(holdingLeftovers.postgres) && orphanedProposalsInTarget === 0 && lostProposals.length === 0,
    holdingLeftovers, orphanedProposalsInTarget, lostProposals,
  };
};

const auditBoth = async (actor: PlacementActor, input: { targetOrganizationId: string; action: string; userId: string; reason: string; metadata: Record<string, unknown> }) => {
  await SecurityAuditEvent.create([
    {
      organizationId: objectId(input.targetOrganizationId), actorUserId: objectId(actor.adminUserId), action: input.action,
      targetType: "user", targetId: input.userId, decision: "allowed", reason: input.reason, correlationId: actor.correlationId, metadata: input.metadata,
    },
    {
      organizationId: objectId(actor.adminOrganizationId), actorUserId: objectId(actor.adminUserId), action: `admin.${input.action}`,
      targetType: "user", targetId: input.userId, decision: "allowed", reason: input.reason, correlationId: actor.correlationId,
      metadata: { ...input.metadata, targetOrganizationId: input.targetOrganizationId },
    },
  ]);
};

export const placeLegacyCustomer = async (input: {
  userId: string; target: PlacementTarget; actor: PlacementActor; pool: Pool | null; runId?: string;
}) => {
  if (!isObjectId(input.userId)) throw new PlacementError("USER_NOT_FOUND", "User not found.", 404);
  const holding = await holdingOf(input.userId);
  if (!holding) throw new PlacementError("NOT_A_LEGACY_CUSTOMER", "This user isn't waiting in a legacy holding tenant.", 409);
  if (input.target.kind === "existing" && input.target.teamId) {
    // Teams arrive with ORG-201; until then a placement can't name one.
    throw new PlacementError("TEAMS_UNAVAILABLE", "Teams aren't available yet; place the user without a team.", 400);
  }

  let targetOrganizationId: string;
  let targetName: string;
  let role: PlacementRole;
  let createdOrganization = false;
  if (input.target.kind === "existing") {
    if (!isObjectId(input.target.organizationId)) throw new PlacementError("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
    if (!(PLACEMENT_ROLES as readonly string[]).includes(input.target.role)) {
      throw new PlacementError("INVALID_ROLE", "Role must be organization_admin, team_manager or planner.", 400);
    }
    const org = await Organization.findOne({ _id: objectId(input.target.organizationId), kind: "customer", status: "active" }).select("_id name").lean();
    if (!org) throw new PlacementError("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
    if (await OrganizationMembership.exists({ organizationId: org._id, userId: objectId(input.userId) })) {
      throw new PlacementError("ALREADY_A_MEMBER", "This user is already a member of that organization.", 409);
    }
    targetOrganizationId = String(org._id);
    targetName = org.name;
    role = input.target.role as PlacementRole;
  } else {
    const details = validateNewOrganization(input.target.organization);
    const org = await Organization.create({ ...details, slug: slugFor(details.name), kind: "customer", status: "active" });
    targetOrganizationId = String(org._id);
    targetName = org.name;
    role = "owner";
    createdOrganization = true;
  }

  const runId = input.runId ?? `placement-${new Date().toISOString()}-${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date();
  await journal().createIndex({ runId: 1 }, { unique: true });
  await journal().insertOne({
    runId, userId: input.userId, holdingOrganizationId: holding.organizationId, targetOrganizationId, createdOrganization, role,
    state: "started", adminUserId: input.actor.adminUserId, adminOrganizationId: input.actor.adminOrganizationId,
    previousVersion: holding.version, createdAt: now, updatedAt: now,
  });
  // tenant-scoped: the holding tenant's proposals, for the post-run check
  const before = (await Proposal.find({ organizationId: objectId(holding.organizationId), userId: objectId(input.userId) }).select("_id").lean()).map((p) => String(p._id));

  let moved: Awaited<ReturnType<typeof moveCustomer>>;
  try {
    moved = await moveCustomer({
      userId: input.userId, fromOrganizationId: holding.organizationId, toOrganizationId: targetOrganizationId, toOrganizationName: targetName,
      runId, apply: true, pool: input.pool,
      onMongoCommit: async (session, result) => {
        // moveMembership made them a Planner; give them the placement role.
        await OrganizationMembership.collection.updateOne(
          { organizationId: objectId(targetOrganizationId), userId: objectId(input.userId) },
          { $set: { roles: [role], status: "active", activatedAt: new Date() }, $inc: { version: 1 } },
          { session },
        );
        await Organization.collection.updateOne({ _id: objectId(holding.organizationId), kind: "legacy_holding" }, { $set: { status: "inactive", updatedAt: new Date() } }, { session });
        await journal().updateOne({ runId }, { $set: { state: "done", mongo: result.mongo, updatedAt: new Date() } }, { session });
      },
    });
  } catch (error) {
    await journal().updateOne({ runId }, { $set: { state: "failed", error: safeError(error), updatedAt: new Date() } });
    throw new PlacementError("PLACEMENT_FAILED", `The placement failed and can be rolled back with run id ${runId}.`, 409);
  }
  const verification = await verify({ userId: input.userId, holdingOrganizationId: holding.organizationId, targetOrganizationId, before, pool: input.pool });
  await journal().updateOne({ runId }, { $set: { postgres: moved.postgres === "skipped" ? {} : moved.postgres, verification, updatedAt: new Date() } });
  await auditBoth(input.actor, {
    targetOrganizationId, action: "organization.legacy_customer.placed", userId: input.userId, reason: createdOrganization ? "new_organization" : "existing_organization",
    metadata: { runId, role, holdingOrganizationId: holding.organizationId, createdOrganization, proposalsMoved: before.length },
  });
  return {
    runId, userId: input.userId, holdingOrganizationId: holding.organizationId, targetOrganizationId, createdOrganization, role,
    mongo: moved.mongo, postgres: moved.postgres, verification,
  };
};

export const getPlacement = async (runId: string) => journal().findOne({ runId }, { projection: { _id: 0 } });

// Moves the customer's records back to their holding tenant and reactivates it. A new
// organization the placement created is deleted when nobody else has joined it.
export const rollbackPlacement = async (input: { runId: string; actor: PlacementActor; pool: Pool | null }) => {
  const entry = await journal().findOne({ runId: input.runId });
  if (!entry) throw new PlacementError("PLACEMENT_NOT_FOUND", "Placement run not found.", 404);
  if (entry.state === "rolled_back") throw new PlacementError("ALREADY_ROLLED_BACK", "This placement was already rolled back.", 409);
  const target = objectId(entry.targetOrganizationId);
  const userId = objectId(entry.userId);
  if (entry.createdOrganization) {
    const others = await OrganizationMembership.countDocuments({ organizationId: target, userId: { $ne: userId } });
    if (others > 0) throw new PlacementError("ORGANIZATION_IN_USE", "Other members have joined the new organization; it can't be rolled back.", 409);
  } else {
    const membership = await OrganizationMembership.findOne({ organizationId: target, userId }).select("roles").lean();
    if (membership?.roles.includes("owner")) throw new PlacementError("USER_IS_OWNER", "The user has since become the Owner; transfer ownership first.", 409);
  }

  const postgres = input.pool
    ? await inPostgres(input.pool, true, async (client, schema) => {
        const from = await postgresOrganizationId(client, entry.targetOrganizationId);
        const to = await postgresOrganizationId(client, entry.holdingOrganizationId);
        if (!from || !to) return "skipped" as const;
        const counts = await moveCustomerRows(client, schema, { fromOrganizationId: from, toOrganizationId: to, userMongoId: entry.userId });
        if (entry.createdOrganization) {
          const remaining = await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM rfpilot.users WHERE organization_id = $1`, [from]);
          if (Number(remaining.rows[0].n) === 0) await client.query("DELETE FROM rfpilot.organizations WHERE id = $1", [from]).catch(() => undefined);
        }
        return counts;
      })
    : ("skipped" as const);

  let mongo: MongoMoveCounts = {};
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      mongo = await moveCustomerDocuments({ fromOrganizationId: entry.targetOrganizationId, toOrganizationId: entry.holdingOrganizationId, userId: entry.userId, apply: true, session });
      await restoreHoldingMembership(entry, session);
      await Organization.collection.updateOne({ _id: objectId(entry.holdingOrganizationId), kind: "legacy_holding" }, { $set: { status: "active", updatedAt: new Date() } }, { session });
      if (entry.createdOrganization) await Organization.collection.deleteOne({ _id: target, kind: "customer" }, { session });
      await journal().updateOne({ runId: entry.runId }, { $set: { state: "rolled_back", updatedAt: new Date() } }, { session });
    });
  } finally {
    await session.endSession();
  }
  await auditBoth(input.actor, {
    targetOrganizationId: entry.targetOrganizationId, action: "organization.legacy_customer.placement_rolled_back", userId: entry.userId,
    reason: "placement_rolled_back", metadata: { runId: entry.runId, holdingOrganizationId: entry.holdingOrganizationId, createdOrganization: entry.createdOrganization },
  });
  return { runId: entry.runId, state: "rolled_back", mongo, postgres };
};

const restoreHoldingMembership = async (entry: JournalEntry, session: ClientSession) => {
  const filter = { organizationId: objectId(entry.targetOrganizationId), userId: objectId(entry.userId) };
  const current = await OrganizationMembership.collection.findOne(filter, { session });
  if (!current) return;
  await OrganizationMembership.collection.updateOne(filter, {
    $set: {
      organizationId: objectId(entry.holdingOrganizationId), roles: ["planner"], status: "active", updatedAt: new Date(),
      // Past every version either side issued, so no earlier token still matches.
      version: Math.max(Number(current.version ?? 1), Number(entry.previousVersion ?? 1)) + 1,
    },
  }, { session });
};
