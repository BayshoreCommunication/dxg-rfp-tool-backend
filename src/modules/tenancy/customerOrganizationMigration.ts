import mongoose from "mongoose";
import type { Pool, PoolClient } from "pg";
import Organization from "../../../modal/organizationModel";
import Proposal from "../../../modal/proposalsModel";
import User from "../../../modal/userModel";
import VendorResponse from "../../../modal/vendorResponseModel";
import { MOVABLE_COLLECTIONS, moveAllDocuments, moveCustomerDocuments, moveMembership, restoreMembership, type MongoMoveCounts } from "./mongoTenantMove";
import { loadTenantSchema, moveAllRows, moveCustomerRows, withRowMovesAllowed, type MoveCounts, type TenantSchema } from "./postgresTenantMove";

// ORG-107: every existing customer in the shared organization moves into a legacy holding tenant
// of their own (kind legacy_holding, one Planner membership, no Owner) with all their MongoDB
// documents and Postgres rows, until a DXG admin places them in a real organization (ORG-110).
// Dry run by default. A run is journaled per customer and rolled back by run id.

const JOURNAL = "customerorganizationmigrations";
const STAFF_ROLES = new Set(["admin", "super_admin", "superadmin"]);

type JournalEntry = {
  runId: string; userId: string; fromOrganizationId: string; holdingOrganizationId: string;
  state: "started" | "done" | "failed" | "rolled_back"; previousRoles?: string[] | null; previousVersion?: number | null;
  error?: string; mongo?: MongoMoveCounts; postgres?: MoveCounts; createdAt: Date; updatedAt: Date;
};
export type CustomerResult = {
  userId: string; holdingOrganizationId: string | null; state: string;
  mongo: MongoMoveCounts; postgres: MoveCounts | "skipped"; error?: string;
};

const journal = () => mongoose.connection.collection<JournalEntry>(JOURNAL);
const safeError = (error: unknown) => (error instanceof Error ? error.message : "Migration step failed").slice(0, 300);

const inPostgres = async <T>(pool: Pool, commit: boolean, work: (client: PoolClient, schema: TenantSchema) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const schema = await loadTenantSchema(client);
    const result = await withRowMovesAllowed(client, schema, () => work(client, schema));
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const postgresOrganizationId = async (client: PoolClient, mongoId: string): Promise<string | null> =>
  (await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1", [mongoId])).rows[0]?.id ?? null;

const ensurePostgresOrganization = async (client: PoolClient, mongoId: string, name: string): Promise<string> =>
  (await postgresOrganizationId(client, mongoId)) ??
  (await client.query<{ id: string }>("INSERT INTO rfpilot.organizations(external_mongo_id, name) VALUES($1, $2) RETURNING id", [mongoId, name.slice(0, 200)])).rows[0].id;

// The reusable core (ORG-110 places a customer with it): moves one customer's Postgres rows and
// MongoDB documents from one organization to another. Postgres is skipped when the source
// organization was never projected there.
export const moveCustomer = async (input: {
  userId: string; fromOrganizationId: string; toOrganizationId: string; toOrganizationName: string;
  runId: string; apply: boolean; pool: Pool | null;
  onMongoCommit?: (session: mongoose.ClientSession, moved: { mongo: MongoMoveCounts; previousRoles: string[] | null; previousVersion: number | null }) => Promise<void>;
}): Promise<{ mongo: MongoMoveCounts; postgres: MoveCounts | "skipped" }> => {
  const postgres = input.pool
    ? await inPostgres(input.pool, input.apply, async (client, schema) => {
        const from = await postgresOrganizationId(client, input.fromOrganizationId);
        if (!from) return "skipped" as const;
        const to = await ensurePostgresOrganization(client, input.toOrganizationId, input.toOrganizationName);
        return moveCustomerRows(client, schema, { fromOrganizationId: from, toOrganizationId: to, userMongoId: input.userId });
      })
    : ("skipped" as const);
  if (!input.apply) {
    const mongo = await moveCustomerDocuments({ ...input, apply: false });
    return { mongo, postgres };
  }
  let mongo: MongoMoveCounts = {};
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      mongo = await moveCustomerDocuments({ ...input, apply: true, session });
      const membership = await moveMembership({ ...input, session });
      await input.onMongoCommit?.(session, { mongo, ...membership });
    });
  } finally {
    await session.endSession();
  }
  return { mongo, postgres };
};

const holdingOrganizationFor = async (user: { _id: unknown; name?: string; company?: string }, apply: boolean) => {
  const slug = `legacy-${String(user._id)}`;
  const existing = await Organization.findOne({ slug }).select("_id name").lean();
  if (existing) return { id: String(existing._id), name: existing.name };
  const name = (user.company?.trim() || user.name?.trim() || "Legacy customer").slice(0, 200);
  if (!apply) return { id: new mongoose.Types.ObjectId().toHexString(), name };
  const created = await Organization.create({ name, slug, kind: "legacy_holding", status: "active" });
  return { id: String(created._id), name };
};

export const migrateCustomerOrganizations = async (input: {
  fromSlug: string; runId: string; apply: boolean; pool: Pool | null; userId?: string;
}) => {
  const from = await Organization.findOne({ slug: input.fromSlug }).select("_id name").lean();
  if (!from) throw new Error(`Organization '${input.fromSlug}' was not found`);
  const fromOrganizationId = String(from._id);
  if (input.apply) await journal().createIndex({ runId: 1, userId: 1 }, { unique: true });

  const customers = await User.find({
    organizationId: from._id,
    ...(input.userId ? { _id: input.userId } : {}),
  }).select("_id name company role").lean<{ _id: unknown; name?: string; company?: string; role?: string }[]>();
  const results: CustomerResult[] = [];
  for (const user of customers.filter((u) => !STAFF_ROLES.has(String(u.role ?? "customer").toLowerCase()))) {
    const userId = String(user._id);
    const done = input.apply ? await journal().findOne({ runId: input.runId, userId, state: "done" }) : null;
    if (done) {
      results.push({ userId, holdingOrganizationId: done.holdingOrganizationId, state: "already_done", mongo: done.mongo ?? {}, postgres: done.postgres ?? {} });
      continue;
    }
    const holding = await holdingOrganizationFor(user, input.apply);
    try {
      if (input.apply) {
        const now = new Date();
        await journal().updateOne(
          { runId: input.runId, userId },
          { $set: { fromOrganizationId, holdingOrganizationId: holding.id, state: "started", updatedAt: now }, $setOnInsert: { createdAt: now } },
          { upsert: true },
        );
      }
      const moved = await moveCustomer({
        userId, fromOrganizationId, toOrganizationId: holding.id, toOrganizationName: holding.name,
        runId: input.runId, apply: input.apply, pool: input.pool,
        onMongoCommit: (session, membership) => journal().updateOne(
          { runId: input.runId, userId },
          { $set: { state: "done", previousRoles: membership.previousRoles, previousVersion: membership.previousVersion, mongo: membership.mongo, updatedAt: new Date() } },
          { session },
        ).then(() => undefined),
      });
      if (input.apply) await journal().updateOne({ runId: input.runId, userId }, { $set: { postgres: moved.postgres === "skipped" ? {} : moved.postgres } });
      results.push({ userId, holdingOrganizationId: input.apply ? holding.id : null, state: input.apply ? "done" : "would_move", ...moved });
    } catch (error) {
      if (input.apply) await journal().updateOne({ runId: input.runId, userId }, { $set: { state: "failed", error: safeError(error), updatedAt: new Date() } });
      results.push({ userId, holdingOrganizationId: input.apply ? holding.id : null, state: "failed", mongo: {}, postgres: {}, error: safeError(error) });
    }
  }

  const fromId = new mongoose.Types.ObjectId(fromOrganizationId);
  const remaining = {
    customers: await User.countDocuments({ organizationId: fromId, role: { $nin: [...STAFF_ROLES] } }),
    proposals: await Proposal.countDocuments({ organizationId: fromId }),
    vendorResponses: await VendorResponse.countDocuments({ organizationId: fromId }),
  };
  return {
    mode: input.apply ? "apply" : "dry_run", runId: input.runId,
    from: { slug: input.fromSlug, organizationId: fromOrganizationId },
    customers: results.length,
    failed: results.filter((r) => r.state === "failed").length,
    results,
    // After a full apply these are all zero: the shared organization keeps only DXG staff.
    remainingInSharedOrganization: remaining,
    movedCollections: MOVABLE_COLLECTIONS,
  };
};

export const rollbackCustomerOrganizations = async (input: { runId: string; apply: boolean; pool: Pool | null }) => {
  const entries = await journal().find({ runId: input.runId, state: { $in: ["done", "failed", "started"] } }).sort({ createdAt: -1 }).toArray();
  const results: Array<{ userId: string; holdingOrganizationId: string; state: string; mongo: MongoMoveCounts; postgres: MoveCounts | "skipped"; error?: string }> = [];
  for (const entry of entries) {
    try {
      const postgres = input.pool
        ? await inPostgres(input.pool, input.apply, async (client, schema) => {
            const holding = await postgresOrganizationId(client, entry.holdingOrganizationId);
            const from = await postgresOrganizationId(client, entry.fromOrganizationId);
            if (!holding || !from) return "skipped" as const;
            const counts = await moveAllRows(client, schema, { fromOrganizationId: holding, toOrganizationId: from });
            await client.query("DELETE FROM rfpilot.organizations WHERE id = $1", [holding]);
            return counts;
          })
        : ("skipped" as const);
      let mongo: MongoMoveCounts = {};
      if (input.apply) {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            mongo = await moveAllDocuments({ fromOrganizationId: entry.holdingOrganizationId, toOrganizationId: entry.fromOrganizationId, session });
            if (entry.state === "done") {
              await restoreMembership({ ...entry, previousRoles: entry.previousRoles ?? null, previousVersion: entry.previousVersion ?? null, session });
            }
            await Organization.collection.deleteOne({ _id: new mongoose.Types.ObjectId(entry.holdingOrganizationId), kind: "legacy_holding" }, { session });
            await journal().updateOne({ runId: entry.runId, userId: entry.userId }, { $set: { state: "rolled_back", updatedAt: new Date() } }, { session });
          });
        } finally {
          await session.endSession();
        }
      } else {
        const holding = new mongoose.Types.ObjectId(entry.holdingOrganizationId);
        for (const name of MOVABLE_COLLECTIONS) {
          const n = await mongoose.connection.collection(name).countDocuments({ organizationId: holding });
          if (n) mongo[name] = n;
        }
      }
      results.push({ userId: entry.userId, holdingOrganizationId: entry.holdingOrganizationId, state: input.apply ? "rolled_back" : "would_roll_back", mongo, postgres });
    } catch (error) {
      results.push({ userId: entry.userId, holdingOrganizationId: entry.holdingOrganizationId, state: "failed", mongo: {}, postgres: {}, error: safeError(error) });
    }
  }
  return { mode: input.apply ? "apply" : "dry_run", rollbackRunId: input.runId, customers: results.length, failed: results.filter((r) => r.state === "failed").length, results };
};
