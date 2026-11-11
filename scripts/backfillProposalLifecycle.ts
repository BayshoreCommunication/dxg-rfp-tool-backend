/**
 * ORG-403: derives Proposal.lifecycle (stage, vendor counts, review and award facts) for proposals
 * written before the lifecycle hooks existed, and repairs any proposal whose stored stage drifted
 * because a hook failed. Dry-run is the default.
 *
 * Idempotent: counts are recomputed from their own collections, review and award facts are only
 * filled when missing (from Postgres comparison runs and decisions, when Postgres is enabled), and
 * a transition (reason "backfill") is appended only when the stored stage or status changes.
 */
import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import { closePostgres, postgresEnabled, withPostgresTransaction } from "../config/postgres";
import Proposal from "../modal/proposalsModel";
import { backfillChange, createProposalLifecycle, type ComparisonHistory } from "../src/modules/proposalLifecycle/application";
import { deriveLifecycleStage } from "../src/modules/proposalLifecycle/domain";
import { mongoProposalLifecycleRepository as repository } from "../src/modules/proposalLifecycle/mongoProposalLifecycleRepository";

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const apply = args.get("--apply") === "true";
const organizationId = args.get("--organization-id");
const proposalId = args.get("--proposal-id");
const requestedLimit = Number.parseInt(args.get("--limit") || "5000", 10);
const limit = Number.isFinite(requestedLimit) ? Math.min(100_000, Math.max(1, requestedLimit)) : 5000;

const help = () =>
  process.stdout.write(`Usage:
  npm run backfill:proposal-lifecycle -- [--limit=5000] [--organization-id=<mongo-id>] [--proposal-id=<mongo-id>]
  npm run backfill:proposal-lifecycle -- --apply [--limit=5000] [--organization-id=<mongo-id>] [--proposal-id=<mongo-id>]

Default mode is dry-run: it reports how many proposals would change stage. --apply writes
Proposal.lifecycle and appends a "backfill" status transition where the stage or status changed.
`);

type Row = { _id: unknown; organizationId?: unknown };

// Comparison runs and decisions per proposal for one organization, read under its RLS context.
const comparisonHistories = async (organizationMongoId: string, proposalMongoIds: string[]) => {
  const histories = new Map<string, ComparisonHistory>();
  if (!postgresEnabled() || proposalMongoIds.length === 0) return histories;
  await withPostgresTransaction(async (client) => {
    await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
    const organization = await client.query<{ id: string }>(
      "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1",
      [organizationMongoId],
    );
    if (!organization.rows[0]) return;
    await client.query("SELECT set_config('app.organization_id',$1,true)", [organization.rows[0].id]);
    const result = await client.query<{
      proposal_mongo_id: string;
      first_run_at: Date | null;
      decision_id: string | null;
      decision_type: "shortlist" | "selection" | "no_award" | null;
      decided_at: Date | null;
      actor_external_user_id: string | null;
    }>(
      `SELECT p.external_mongo_id AS proposal_mongo_id,
              (SELECT min(r.created_at) FROM rfpilot.comparison_runs r
                WHERE r.organization_id=p.organization_id AND r.proposal_reference_id=p.id) AS first_run_at,
              d.id AS decision_id, d.decision_type, d.created_at AS decided_at, d.actor_external_user_id
         FROM rfpilot.proposal_references p
         LEFT JOIN LATERAL (
           SELECT d.id, d.decision_type, d.created_at, d.actor_external_user_id
             FROM rfpilot.comparison_decisions d
             JOIN rfpilot.comparison_runs r ON r.organization_id=d.organization_id AND r.id=d.comparison_run_id
            WHERE r.organization_id=p.organization_id AND r.proposal_reference_id=p.id
            ORDER BY d.created_at DESC, d.id DESC
            LIMIT 1
         ) d ON true
        WHERE p.organization_id=$1 AND p.external_mongo_id = ANY($2::text[])`,
      [organization.rows[0].id, proposalMongoIds],
    );
    for (const row of result.rows) {
      histories.set(row.proposal_mongo_id, {
        firstRunAt: row.first_run_at,
        latestDecision: row.decision_id && row.decision_type && row.decided_at
          ? { decisionType: row.decision_type, decisionId: row.decision_id, at: row.decided_at, actorUserId: row.actor_external_user_id }
          : null,
      });
    }
  });
  return histories;
};

const main = async () => {
  if (args.has("--help")) return help();
  for (const [flag, value] of [["--organization-id", organizationId], ["--proposal-id", proposalId]] as const) {
    if (value && !mongoose.isValidObjectId(value)) throw new Error(`${flag} must be a valid Mongo id`);
  }
  await connectDB();
  const lifecycle = createProposalLifecycle({ repository });
  // scope-exempt: an operator backfill across organizations; every write below names the organization.
  const rows = await Proposal.find({
    organizationId: organizationId ? organizationId : { $ne: null },
    ...(proposalId ? { _id: proposalId } : {}),
  })
    .select("_id organizationId")
    .sort({ _id: 1 })
    .limit(limit)
    .lean<Row[]>();

  const byOrganization = new Map<string, string[]>();
  for (const row of rows) {
    const org = String(row.organizationId);
    byOrganization.set(org, [...(byOrganization.get(org) ?? []), String(row._id)]);
  }

  const summary = { mode: apply ? "apply" : "dry-run", scanned: rows.length, stageChanges: 0, unchanged: 0, failed: 0, byStage: {} as Record<string, number> };
  for (const [org, ids] of byOrganization) {
    const histories = await comparisonHistories(org, ids);
    for (const id of ids) {
      const ref = { organizationId: org, proposalId: id };
      try {
        const change = backfillChange(histories.get(id) ?? null);
        let stage: string;
        let changed: boolean;
        if (apply) {
          const result = await lifecycle.sync({ ...ref, actor: { type: "system" }, reason: "backfill", recount: ["invited", "responded"], change });
          if (!result) continue;
          stage = result.stage;
          changed = result.transitioned;
        } else {
          const current = await repository.load(ref);
          if (!current) continue;
          const next = {
            ...current.state,
            vendorsInvited: await repository.countVendorsInvited(ref),
            vendorsResponded: await repository.countVendorsResponded(ref),
            ...(change(current) ?? {}),
          };
          stage = deriveLifecycleStage(current.facts, next);
          changed = current.state.stage !== stage || (current.state.status ?? null) !== (current.facts.status ?? null);
        }
        summary.byStage[stage] = (summary.byStage[stage] ?? 0) + 1;
        if (changed) summary.stageChanges += 1;
        else summary.unchanged += 1;
      } catch {
        summary.failed += 1;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed > 0) process.exitCode = 1;
};

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
    await closePostgres().catch(() => undefined);
  });
