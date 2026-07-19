import "../config/env";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { v7 as uuidv7 } from "uuid";
import connectDB from "../config/db";
import { postgresPool, withPostgresTransaction, closePostgres } from "../config/postgres";
import Organization from "../modal/organizationModel";
import User from "../modal/userModel";
import Proposal from "../modal/proposalsModel";
import { synchronizeProposalReference } from "../src/modules/dataFoundation/composition";

const args = new Set(process.argv.slice(2));
const value = (name: string) => process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const apply = args.has("--apply");
const help = args.has("--help");
const rollbackRun = value("rollback-run");
const runId = value("run-id") || `proposal-refs-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const organizationMongoId = value("organization-id");

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
};
const checksum = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const seedIdentityReferences = async (organization: { _id: unknown; name?: string }, users: Array<{ _id: unknown }>) =>
  withPostgresTransaction(async (client) => {
    const organizationId = uuidv7();
    const org = await client.query<{ id: string }>(`
      INSERT INTO rfpilot.organizations(id, external_mongo_id, name)
      VALUES ($1,$2,$3)
      ON CONFLICT (external_mongo_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
      RETURNING id
    `, [organizationId, String(organization._id), organization.name?.trim() || "DXG"]);
    await client.query("SELECT set_config('app.organization_id', $1, true)", [org.rows[0].id]);
    for (const user of users) {
      await client.query(`
        INSERT INTO rfpilot.users(id, organization_id, external_mongo_id)
        VALUES ($1,$2,$3)
        ON CONFLICT (organization_id, external_mongo_id) DO UPDATE SET status = 'active', updated_at = now()
      `, [uuidv7(), org.rows[0].id, String(user._id)]);
    }
    return org.rows[0].id;
  });

const rollback = async (targetRun: string) => {
  const pool = postgresPool();
  const journal = await pool.query<{ details: { organizationPostgresId?: string; createdReferenceIds?: string[]; createdReferences?: Array<{ id: string; sourceChecksum: string }>; createdOutboxIds?: string[] }; outcome: string; created_at: Date }>(
    "SELECT details, outcome, created_at FROM rfpilot.migration_journal WHERE run_id = $1 AND migration_type = 'proposal_reference_backfill' AND outcome = 'applied' ORDER BY created_at DESC LIMIT 1",
    [targetRun],
  );
  if (!journal.rows[0]) throw new Error("Applied migration journal not found");
  const referenceEvidence = journal.rows[0].details.createdReferences ?? [];
  const refs = referenceEvidence.length ? referenceEvidence.map((item) => item.id) : (journal.rows[0].details.createdReferenceIds ?? []);
  const events = journal.rows[0].details.createdOutboxIds ?? [];
  const organizationPostgresId = journal.rows[0].details.organizationPostgresId;
  if (!organizationPostgresId) throw new Error("Rollback journal has no PostgreSQL organization ID");
  const eligibleResult = await withPostgresTransaction(async (client) => {
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationPostgresId]);
    if (referenceEvidence.length) {
      return client.query<{ id: string }>(`
        SELECT pr.id FROM rfpilot.proposal_references pr
        JOIN jsonb_to_recordset($1::jsonb) AS evidence(id uuid, "sourceChecksum" text)
          ON evidence.id = pr.id AND evidence."sourceChecksum" = pr.source_checksum
      `, [JSON.stringify(referenceEvidence)]);
    }
    return client.query<{ id: string }>("SELECT id FROM rfpilot.proposal_references WHERE id = ANY($1::uuid[]) AND updated_at <= $2", [refs, journal.rows[0].created_at]);
  });
  const eligibleRefs = eligibleResult.rows.map((row) => row.id);
  const conflicts = refs.filter((id) => !eligibleRefs.includes(id));
  console.log(JSON.stringify({ mode: apply ? "rollback-apply" : "rollback-preview", runId: targetRun, proposalReferences: eligibleRefs.length, outboxEvents: events.length, modifiedReferenceConflicts: conflicts.length }, null, 2));
  if (!apply) return;
  await withPostgresTransaction(async (client) => {
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationPostgresId]);
    await client.query("DELETE FROM rfpilot.outbox_events WHERE id = ANY($1::uuid[])", [events]);
    await client.query("DELETE FROM rfpilot.proposal_references WHERE id = ANY($1::uuid[])", [eligibleRefs]);
    await client.query(`
      INSERT INTO rfpilot.migration_journal(run_id,migration_type,source_system,source_count,applied_count,conflict_count,checksum,outcome,details)
      VALUES ($1,'proposal_reference_backfill','mongodb',0,$2,$3,$4,'rolled_back',$5::jsonb)
    `, [targetRun, eligibleRefs.length, conflicts.length, checksum({ eligibleRefs, events, conflicts }), JSON.stringify({ deletedReferenceIds: eligibleRefs, deletedOutboxIds: events, modifiedReferenceConflicts: conflicts })]);
  });
};

const main = async () => {
  if (help) {
    console.log("Usage: npm run backfill:postgres-proposals -- --organization-id=<mongo-id> [--run-id=<id>] [--apply]\n       npm run backfill:postgres-proposals -- --rollback-run=<id> [--apply]");
    return;
  }
  if (rollbackRun) { await rollback(rollbackRun); return; }
  if (!organizationMongoId || !mongoose.isValidObjectId(organizationMongoId)) throw new Error("Valid --organization-id is required");
  await connectDB();
  const organization = await Organization.findById(organizationMongoId).select("_id name").lean();
  if (!organization) throw new Error("MongoDB organization not found");
  const users = await User.find({ organizationId: organizationMongoId }).select("_id").lean();
  const proposals = await Proposal.find({ organizationId: organizationMongoId }).sort({ _id: 1 }).lean();
  const missingOwner = proposals.filter((proposal) => !users.some((user) => String(user._id) === String(proposal.userId)));
  const summary = { mode: apply ? "apply" : "dry-run", runId, organizationId: organizationMongoId, users: users.length, proposals: proposals.length, missingOwners: missingOwner.length };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply || missingOwner.length) return;
  const existingRun = await postgresPool().query(
    "SELECT 1 FROM rfpilot.migration_journal WHERE run_id = $1 AND migration_type = 'proposal_reference_backfill' AND outcome = 'applied'",
    [runId],
  );
  if (existingRun.rowCount) {
    console.log(JSON.stringify({ ...summary, outcome: "already_applied" }, null, 2));
    return;
  }
  const organizationPostgresId = await seedIdentityReferences(organization, users);
  const createdReferenceIds: string[] = [];
  const createdReferences: Array<{ id: string; sourceChecksum: string }> = [];
  const createdOutboxIds: string[] = [];
  for (const proposal of proposals) {
    const result = await synchronizeProposalReference({
      organizationMongoId,
      ownerUserMongoId: String(proposal.userId),
      proposalMongoId: String(proposal._id),
      sourceVersion: String(proposal.__v ?? 0),
      sourceChecksum: checksum(proposal),
      sourceUpdatedAt: proposal.updatedAt,
      correlationId: runId,
      eventType: "proposal.reference.backfilled",
    });
    if (result.kind !== "synchronized") throw new Error(`Failed to synchronize proposal ${proposal._id}`);
    if (result.referenceCreated) {
      createdReferenceIds.push(result.proposalReferenceId);
      createdReferences.push({ id: result.proposalReferenceId, sourceChecksum: checksum(proposal) });
    }
    if (result.outboxCreated) createdOutboxIds.push(result.outboxEventId);
  }
  await postgresPool().query(`
    INSERT INTO rfpilot.migration_journal(run_id,migration_type,source_system,source_count,applied_count,conflict_count,checksum,outcome,details)
    VALUES ($1,'proposal_reference_backfill','mongodb',$2,$3,0,$4,'applied',$5::jsonb)
  `, [runId, proposals.length, proposals.length, checksum(proposals.map((proposal) => String(proposal._id))), JSON.stringify({ organizationPostgresId, createdReferenceIds, createdReferences, createdOutboxIds })]);
  console.log(JSON.stringify({ ...summary, createdReferences: createdReferenceIds.length, createdOutboxEvents: createdOutboxIds.length, outcome: "applied" }, null, 2));
};

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(async () => {
  await mongoose.disconnect();
  await closePostgres();
});
