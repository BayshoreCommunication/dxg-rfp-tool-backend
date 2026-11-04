import crypto from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import type { Pool, PoolClient } from "pg";
import Organization, { ORGANIZATION_TYPES } from "../../../modal/organizationModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import Proposal from "../../../modal/proposalsModel";
import SecurityAuditEvent from "../../../modal/securityAuditEventModel";
import Team from "../../../modal/teamModel";
import TeamMembership from "../../../modal/teamMembershipModel";
import User from "../../../modal/userModel";
import { ensurePostgresOrganization, postgresOrganizationId } from "./customerOrganizationMigration";
import { moveAllDocuments, moveCustomerDocuments, moveDocumentsById, moveMembership, type MongoMoveCounts, type MovedDocumentIds } from "./mongoTenantMove";
import { loadTenantSchema, moveAllRows, moveCustomerRows, moveRowsByKey, withRowMovesAllowed, type MoveCounts, type MovedKeys, type TenantSchema } from "./postgresTenantMove";
import { findCustomerLeftovers, findOrphanedProposals } from "./migrationVerification";

// ORG-110: a DXG admin places a legacy customer (ORG-107 moved each one into a holding tenant of
// their own) into a real organization: a new one, where they become Owner, or an existing one,
// with a role other than Owner or Viewer and optionally a team. The holding tenant's MongoDB and
// Postgres records move with ORG-107's rewrite as one journaled run. The holding tenant is
// retired, audit events go to the target organization and the admin's own trail, and ORG-109's
// checks run after every run.
//
// Atomicity: the Postgres move stays uncommitted while the MongoDB transaction runs and commits
// only after it, so a MongoDB failure leaves both stores untouched. A run whose checks fail is
// rolled back at once and reported as an error.
//
// Rollback moves back exactly the documents and rows the run moved (their ids are journaled), so
// a receiving organization's own data never leaves it, even when the placed user has since been
// given a colleague's RFP. A new organization the run created is emptied and deleted instead.

const JOURNAL = "legacycustomerplacements";
// The ids a run moved, in chunks (a large customer would outgrow one journal document).
const MOVED = "legacycustomerplacementmoves";
const CHUNK = 5000;
export const PLACEMENT_ROLES = ["organization_admin", "team_manager", "planner"] as const;
export type PlacementRole = (typeof PLACEMENT_ROLES)[number] | "owner";

export type NewOrganizationDetails = {
  name: string; type?: string | null; industry?: string | null; country?: string | null;
  timeZone?: string | null; eventsPerYear?: number | null;
};
export type PlacementTarget =
  | { kind: "new"; organization: NewOrganizationDetails }
  | { kind: "existing"; organizationId: string; role: string; teamId?: string | null };

// started → done | failed (Postgres commit failed after MongoDB committed; roll back) | aborted
// (nothing moved); done | failed → rolling_back → rolled_back. inFlight is set only while a
// placement runs and is unique per user, so a double submit can't start a second run.
type PlacementState = "started" | "done" | "failed" | "aborted" | "rolling_back" | "rolled_back";
type JournalEntry = {
  runId: string; userId: string; holdingOrganizationId: string; targetOrganizationId: string;
  createdOrganization: boolean; role: PlacementRole; teamId?: string | null; state: PlacementState; inFlight?: boolean;
  rollbackFrom?: PlacementState; adminUserId: string; adminOrganizationId: string; error?: string;
  previousVersion?: number | null; mongo?: MongoMoveCounts; postgres?: MoveCounts | Record<string, never>;
  verification?: PlacementVerification; createdAt: Date; updatedAt: Date;
};
type MovedChunk = { runId: string; store: "mongo" | "postgres"; name: string; ids: unknown[] };

export type PlacementVerification = {
  passed: boolean;
  holdingLeftovers: { mongo: Record<string, number>; postgres: Record<string, number> };
  orphanedProposalsInTarget: number;
  lostProposals: string[];
};

export class PlacementError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 503 = 409, readonly details?: Record<string, unknown>) { super(message); }
}

export type PlacementActor = { adminUserId: string; adminOrganizationId: string; correlationId: string };

const journal = () => mongoose.connection.collection<JournalEntry>(JOURNAL);
const moved = () => mongoose.connection.collection<MovedChunk>(MOVED);
let indexes: Promise<unknown> | null = null;
const ensureIndexes = () => (indexes ??= Promise.all([
  journal().createIndex({ runId: 1 }, { unique: true }),
  journal().createIndex({ userId: 1 }, { unique: true, name: "one_placement_in_flight_per_user", partialFilterExpression: { inFlight: true } }),
  moved().createIndex({ runId: 1 }),
]).catch((error) => { indexes = null; throw error; }));
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;
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


const orphansIn = async (organizationId: string) =>
  (await findOrphanedProposals({ sampleSize: 0, organizationId })).byOrganization.find((o) => o.organizationId === organizationId)?.count ?? 0;

// An existing organization may already have orphaned RFPs; the run must not add any.
const verify = async (input: {
  userId: string; holdingOrganizationId: string; targetOrganizationId: string; before: string[]; orphansBefore: number; pool: Pool | null;
}): Promise<PlacementVerification> => {
  const holdingLeftovers = await findCustomerLeftovers({ organizationId: input.holdingOrganizationId, pool: input.pool });
  const orphanedProposalsInTarget = await orphansIn(input.targetOrganizationId);
  // The customer still owns every proposal they owned in the holding tenant.
  const owned = new Set((await Proposal.find({ organizationId: objectId(input.targetOrganizationId), userId: objectId(input.userId) }).select("_id").lean()).map((p) => String(p._id)));
  const lostProposals = input.before.filter((id) => !owned.has(id));
  const empty = (counts: Record<string, number>) => Object.keys(counts).length === 0;
  return {
    passed: empty(holdingLeftovers.mongo) && empty(holdingLeftovers.postgres) && orphanedProposalsInTarget <= input.orphansBefore && lostProposals.length === 0,
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

// A Postgres move that is done but not yet committed: the caller commits once MongoDB has, or
// aborts. Deferred foreign keys are already checked when this returns.
type HeldPostgres<T> = { result: T; commit(): Promise<void>; abort(): Promise<void> };
const holdPostgresMove = async <T>(
  pool: Pool | null, skipped: T, work: (client: PoolClient, schema: TenantSchema) => Promise<T>,
): Promise<HeldPostgres<T>> => {
  if (!pool) return { result: skipped, commit: async () => undefined, abort: async () => undefined };
  const client = await pool.connect();
  let result: T;
  try {
    await client.query("BEGIN");
    const schema = await loadTenantSchema(client);
    result = await withRowMovesAllowed(client, schema, () => work(client, schema));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
  let open = true;
  const finish = async (sql: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    open = false;
    try { await client.query(sql); } finally { client.release(); }
  };
  return { result, commit: () => finish("COMMIT"), abort: () => finish("ROLLBACK").catch(() => undefined) };
};

const saveMoved = async (runId: string, mongoIds: MovedDocumentIds, postgresKeys: MovedKeys, session: ClientSession) => {
  const chunks: MovedChunk[] = [];
  const add = (store: MovedChunk["store"], all: Record<string, unknown[]>) => {
    for (const [name, ids] of Object.entries(all)) {
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push({ runId, store, name, ids: ids.slice(i, i + CHUNK) });
    }
  };
  add("mongo", mongoIds);
  add("postgres", postgresKeys);
  if (chunks.length) await moved().insertMany(chunks, { session });
};

const loadMoved = async (runId: string) => {
  const mongoIds: MovedDocumentIds = {};
  const postgresKeys: MovedKeys = {};
  for await (const chunk of moved().find({ runId })) {
    if (chunk.store === "mongo") (mongoIds[chunk.name] ??= []).push(...chunk.ids);
    else (postgresKeys[chunk.name] ??= []).push(...(chunk.ids as string[]));
  }
  return { mongoIds, postgresKeys };
};

const resolveTarget = async (userId: string, target: PlacementTarget) => {
  if (target.kind === "new") {
    const details = validateNewOrganization(target.organization);
    // Created inside the MongoDB transaction, so an aborted run leaves no organization behind.
    return { organizationId: new mongoose.Types.ObjectId().toHexString(), name: details.name, role: "owner" as PlacementRole, created: details, teamId: null };
  }
  if (!isObjectId(target.organizationId)) throw new PlacementError("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
  if (!(PLACEMENT_ROLES as readonly string[]).includes(target.role)) {
    throw new PlacementError("INVALID_ROLE", "Role must be organization_admin, team_manager or planner.", 400);
  }
  const org = await Organization.findOne({ _id: objectId(target.organizationId), kind: "customer", status: "active" }).select("_id name").lean();
  if (!org) throw new PlacementError("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
  if (await OrganizationMembership.exists({ organizationId: org._id, userId: objectId(userId) })) {
    throw new PlacementError("ALREADY_A_MEMBER", "This user is already a member of that organization.", 409);
  }
  const teamId = target.teamId ? String(target.teamId) : null;
  if (teamId && !(isObjectId(teamId) && await Team.exists({ _id: objectId(teamId), organizationId: org._id, archived: false }))) {
    throw new PlacementError("UNKNOWN_TEAM", "That team isn't an active team of the organization.", 400);
  }
  return { organizationId: String(org._id), name: org.name, role: target.role as PlacementRole, created: null, teamId };
};

export const placeLegacyCustomer = async (input: {
  userId: string; target: PlacementTarget; actor: PlacementActor; pool: Pool | null; runId?: string;
}) => {
  if (!isObjectId(input.userId)) throw new PlacementError("USER_NOT_FOUND", "User not found.", 404);
  const holding = await holdingOf(input.userId);
  if (!holding) throw new PlacementError("NOT_A_LEGACY_CUSTOMER", "This user isn't waiting in a legacy holding tenant.", 409);
  const target = await resolveTarget(input.userId, input.target);
  const { organizationId: targetOrganizationId, role } = target;
  const createdOrganization = target.created !== null;

  const runId = input.runId ?? `placement-${new Date().toISOString()}-${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date();
  await ensureIndexes();
  try {
    await journal().insertOne({
      runId, userId: input.userId, holdingOrganizationId: holding.organizationId, targetOrganizationId, createdOrganization, role,
      teamId: target.teamId, state: "started", inFlight: true, adminUserId: input.actor.adminUserId, adminOrganizationId: input.actor.adminOrganizationId,
      previousVersion: holding.version, createdAt: now, updatedAt: now,
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new PlacementError("PLACEMENT_IN_PROGRESS", "This user is already being placed.", 409);
    throw error;
  }
  const finishRun = (set: Partial<JournalEntry>, session?: ClientSession) =>
    journal().updateOne({ runId }, { $set: { ...set, updatedAt: new Date() }, $unset: { inFlight: "" } }, { session });

  let held: HeldPostgres<MoveCounts | "skipped"> | null = null;
  let mongo: MongoMoveCounts = {};
  let before: string[];
  let orphansBefore: number;
  try {
    // tenant-scoped: the holding tenant's proposals, for the post-run check
    before = (await Proposal.find({ organizationId: objectId(holding.organizationId), userId: objectId(input.userId) }).select("_id").lean()).map((p) => String(p._id));
    orphansBefore = createdOrganization ? 0 : await orphansIn(targetOrganizationId);
    const postgresKeys: MovedKeys = {};
    held = await holdPostgresMove<MoveCounts | "skipped">(input.pool, "skipped", async (client, schema) => {
      const from = await postgresOrganizationId(client, holding.organizationId);
      if (!from) return "skipped";
      const to = await ensurePostgresOrganization(client, targetOrganizationId, target.name);
      return moveCustomerRows(client, schema, { fromOrganizationId: from, toOrganizationId: to, userMongoId: input.userId, keys: postgresKeys });
    });
    const postgres = held.result;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (target.created) {
          await Organization.create([{ _id: objectId(targetOrganizationId), ...target.created, slug: slugFor(target.created.name), kind: "customer", status: "active" }], { session });
        }
        // Retiring the holding tenant is the run's claim on it: a run that finds it already
        // retired lost a race and moves nothing.
        const retired = await Organization.collection.updateOne(
          { _id: objectId(holding.organizationId), kind: "legacy_holding", status: "active" },
          { $set: { status: "inactive", updatedAt: new Date() } }, { session },
        );
        if (retired.matchedCount !== 1) throw new PlacementError("NOT_A_LEGACY_CUSTOMER", "This user isn't waiting in a legacy holding tenant.", 409);
        const mongoIds: MovedDocumentIds = {};
        mongo = await moveCustomerDocuments({ fromOrganizationId: holding.organizationId, toOrganizationId: targetOrganizationId, userId: input.userId, apply: true, session, movedIds: mongoIds });
        await moveMembership({ fromOrganizationId: holding.organizationId, toOrganizationId: targetOrganizationId, userId: input.userId, runId, session });
        // moveMembership made them a Planner; give them the placement role.
        await OrganizationMembership.collection.updateOne(
          { organizationId: objectId(targetOrganizationId), userId: objectId(input.userId) },
          { $set: { roles: [role], status: "active", activatedAt: new Date() }, $inc: { version: 1 } },
          { session },
        );
        if (target.teamId) {
          await TeamMembership.create([{ organizationId: objectId(targetOrganizationId), teamId: objectId(target.teamId), userId: objectId(input.userId), isManager: false }], { session });
        }
        await moved().deleteMany({ runId }, { session });
        await saveMoved(runId, mongoIds, postgresKeys, session);
        await finishRun({ state: "done", mongo, postgres: postgres === "skipped" ? {} : postgres }, session);
      });
    } finally {
      await session.endSession();
    }
  } catch (error) {
    await held?.abort();
    await finishRun({ state: "aborted", error: safeError(error) });
    if (error instanceof PlacementError) throw error;
    throw new PlacementError("PLACEMENT_FAILED", `The placement failed (run ${runId}); nothing was moved.`, 409);
  }
  try {
    await held.commit();
  } catch (error) {
    await journal().updateOne({ runId }, { $set: { state: "failed", error: `Postgres commit failed: ${safeError(error)}`, updatedAt: new Date() } });
    throw new PlacementError("PLACEMENT_FAILED", `The placement failed part way and must be rolled back with run id ${runId}.`, 409);
  }

  const verification = await verify({ userId: input.userId, holdingOrganizationId: holding.organizationId, targetOrganizationId, before, orphansBefore, pool: input.pool });
  await journal().updateOne({ runId }, { $set: { verification, updatedAt: new Date() } });
  if (!verification.passed) {
    let rolledBack = true;
    try {
      await rollbackRun({ runId, actor: input.actor, pool: input.pool, reason: "verification_failed" });
    } catch {
      rolledBack = false;
    }
    throw new PlacementError(
      "PLACEMENT_VERIFICATION_FAILED",
      rolledBack
        ? `The placement's checks failed, so it was rolled back (run ${runId}).`
        : `The placement's checks failed and the automatic rollback did not complete; roll back run ${runId}.`,
      409, { runId, rolledBack, verification },
    );
  }
  await auditBoth(input.actor, {
    targetOrganizationId, action: "organization.legacy_customer.placed", userId: input.userId, reason: createdOrganization ? "new_organization" : "existing_organization",
    metadata: { runId, role, teamId: target.teamId, holdingOrganizationId: holding.organizationId, createdOrganization, proposalsMoved: before.length },
  });
  return {
    runId, userId: input.userId, holdingOrganizationId: holding.organizationId, targetOrganizationId, createdOrganization, role, teamId: target.teamId,
    mongo, postgres: held.result, verification,
  };
};

export const getPlacement = async (runId: string) => journal().findOne({ runId }, { projection: { _id: 0 } });

// One rollback per run: the journal entry is claimed (done | failed → rolling_back) before
// anything moves, and released back to its state if the rollback refuses or fails.
const claimRollback = async (runId: string) => {
  const claimed = await journal().findOneAndUpdate(
    { runId, state: { $in: ["done", "failed"] } },
    [{ $set: { rollbackFrom: "$state", state: "rolling_back", updatedAt: "$$NOW" } }],
    { returnDocument: "before" },
  );
  if (claimed) return claimed;
  const entry = await journal().findOne({ runId });
  if (!entry) throw new PlacementError("PLACEMENT_NOT_FOUND", "Placement run not found.", 404);
  if (entry.state === "rolled_back") throw new PlacementError("ALREADY_ROLLED_BACK", "This placement was already rolled back.", 409);
  if (entry.state === "rolling_back") throw new PlacementError("ROLLBACK_IN_PROGRESS", "This placement is being rolled back.", 409);
  if (entry.state === "aborted") throw new PlacementError("NOTHING_TO_ROLL_BACK", "This placement failed before anything moved.", 409);
  throw new PlacementError("PLACEMENT_IN_PROGRESS", "This placement is still running.", 409);
};

const rollbackRun = async (input: { runId: string; actor: PlacementActor; pool: Pool | null; reason: string }) => {
  const entry = await claimRollback(input.runId);
  const release = () => journal().updateOne({ runId: entry.runId, state: "rolling_back" }, { $set: { state: entry.state, updatedAt: new Date() }, $unset: { rollbackFrom: "" } });
  let result: { mongo: MongoMoveCounts; postgres: MoveCounts | "skipped"; leftInTarget: { proposals: number } };
  try {
    result = await performRollback(entry, input.pool);
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  await auditBoth(input.actor, {
    targetOrganizationId: entry.targetOrganizationId, action: "organization.legacy_customer.placement_rolled_back", userId: entry.userId,
    reason: input.reason, metadata: { runId: entry.runId, holdingOrganizationId: entry.holdingOrganizationId, createdOrganization: entry.createdOrganization },
  });
  return { runId: entry.runId, state: "rolled_back" as const, ...result };
};

// Moves the customer's records back to their holding tenant and reactivates it. A new
// organization the placement created is deleted when nobody else has joined it.
export const rollbackPlacement = (input: { runId: string; actor: PlacementActor; pool: Pool | null }) =>
  rollbackRun({ ...input, reason: "placement_rolled_back" });

const performRollback = async (entry: JournalEntry, pool: Pool | null) => {
  const target = objectId(entry.targetOrganizationId);
  const userId = objectId(entry.userId);
  if (entry.createdOrganization) {
    const others = await OrganizationMembership.countDocuments({ organizationId: target, userId: { $ne: userId } });
    if (others > 0) throw new PlacementError("ORGANIZATION_IN_USE", "Other members have joined the new organization; it can't be rolled back.", 409);
  } else {
    const membership = await OrganizationMembership.findOne({ organizationId: target, userId }).select("roles").lean();
    if (membership?.roles.includes("owner")) throw new PlacementError("USER_IS_OWNER", "The user has since become the Owner; transfer ownership first.", 409);
  }
  const { mongoIds, postgresKeys } = await loadMoved(entry.runId);

  let held: HeldPostgres<MoveCounts | "skipped">;
  try {
    held = await holdPostgresMove<MoveCounts | "skipped">(pool, "skipped", async (client, schema) => {
      const from = await postgresOrganizationId(client, entry.targetOrganizationId);
      const to = await postgresOrganizationId(client, entry.holdingOrganizationId);
      if (!from || !to) return "skipped";
      if (!entry.createdOrganization) return moveRowsByKey(client, schema, { fromOrganizationId: from, toOrganizationId: to, keys: postgresKeys });
      // Nobody else joined the new organization, so everything in it is the customer's.
      const counts = await moveAllRows(client, schema, { fromOrganizationId: from, toOrganizationId: to });
      // Best effort: a row elsewhere still naming the organization keeps it, empty.
      await client.query("SAVEPOINT drop_organization");
      await client.query("DELETE FROM rfpilot.organizations WHERE id = $1", [from])
        .then(() => client.query("RELEASE SAVEPOINT drop_organization"))
        .catch(() => client.query("ROLLBACK TO SAVEPOINT drop_organization"));
      return counts;
    });
  } catch (error) {
    // A row created in the organization since the placement still points at one going back.
    if ((error as { code?: string })?.code === "23503") {
      throw new PlacementError("ROLLBACK_CONFLICT", "Records created in the organization since the placement depend on the user's records, so it can't be rolled back.", 409);
    }
    throw error;
  }

  let mongo: MongoMoveCounts = {};
  let leftInTarget = { proposals: 0 };
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      mongo = entry.createdOrganization
        ? await moveAllDocuments({ fromOrganizationId: entry.targetOrganizationId, toOrganizationId: entry.holdingOrganizationId, session })
        : await moveDocumentsById({ fromOrganizationId: entry.targetOrganizationId, toOrganizationId: entry.holdingOrganizationId, ids: mongoIds, session });
      await restoreHoldingMembership(entry, session);
      await TeamMembership.collection.deleteMany({ organizationId: target, userId }, { session });
      await Organization.collection.updateOne({ _id: objectId(entry.holdingOrganizationId), kind: "legacy_holding" }, { $set: { status: "active", updatedAt: new Date() } }, { session });
      if (entry.createdOrganization) await Organization.collection.deleteOne({ _id: target, kind: "customer" }, { session });
      // RFPs given to the user after the placement belong to the organization and stay; an
      // Admin reassigns them (ORG-109 reports them as orphaned until then).
      leftInTarget = { proposals: entry.createdOrganization ? 0 : await Proposal.collection.countDocuments({ organizationId: target, userId }, { session }) };
      await journal().updateOne({ runId: entry.runId }, { $set: { state: "rolled_back", leftInTarget, updatedAt: new Date() }, $unset: { inFlight: "" } }, { session });
    });
  } catch (error) {
    await held.abort();
    throw error;
  } finally {
    await session.endSession();
  }
  await held.commit();
  return { mongo, postgres: held.result, leftInTarget };
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
