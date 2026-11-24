import Organization from "../../../modal/organizationModel";
import Proposal from "../../../modal/proposalsModel";
import { postgresEnabled, withPostgresTransaction } from "../../../config/postgres";
import { safeLog } from "../../shared/observability/safeTelemetry";
import { purgeProposalArtifacts } from "./purgeProposalArtifacts";

// Finishes proposal purges that stopped half way.
//
// A planner's permanent delete removes the proposal from MongoDB even when the
// storage step failed, which leaves source rows `deletion_pending` with nothing
// that identifies the proposal to the archive sweep any more. This pass finds
// those rows from the Postgres side and runs the purge again for them.
//
// What it works on, and what it leaves:
//
//   - Organizations come from MongoDB, the identity authority, as the retention
//     sweep does; the caller passes the ids to leave out (blocked
//     organizations). Each organization is then read in its own transaction
//     with its own tenant GUCs, as the application role: no cross-tenant read.
//   - Within one organization it takes proposal references that have a live
//     `deletion_pending` source which is not under legal hold or retention.
//   - MongoDB then decides. A proposal that still exists and does NOT carry
//     `purgeStartedAt` is left alone: its `deletion_pending` document came from
//     a single-document delete (requestDeletion), which is not this job's to
//     finish. A proposal that carries the marker gets the full purge. A
//     proposal MongoDB no longer has gets only its already-pending sources
//     finished; nothing new is marked for a proposal known from Postgres alone.
//   - At most `limit` proposals per run, oldest pending source first.

const DEFAULT_LIMIT = 200;
const runLimit = () => Math.max(1, Math.min(Number(process.env.PROPOSAL_PURGE_RECONCILE_BATCH) || DEFAULT_LIMIT, 2000));

export type StrandedPurgeRun = {
  /** Organizations that had at least one candidate. */
  organizations: number;
  /** Proposals whose purge finished in this run. */
  completed: number;
  /** Proposals tried and still not finished; they are tried again next run. */
  incomplete: number;
  /** Candidates left alone because the proposal still exists and is not being deleted. */
  leftAlone: number;
};

const pendingProposals = (organizationMongoId: string, limit: number): Promise<string[]> =>
  withPostgresTransaction(async (c) => {
    await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
    const org = await c.query<{ id: string }>(
      "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
      [organizationMongoId],
    );
    if (!org.rows[0]) return [];
    await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
    const rows = await c.query<{ external_mongo_id: string }>(
      `SELECT p.external_mongo_id
         FROM rfpilot.document_sources s
         JOIN rfpilot.proposal_references p ON p.id = s.proposal_reference_id AND p.organization_id = s.organization_id
        WHERE s.organization_id=$1 AND s.status='deletion_pending' AND s.deleted_at IS NULL
          AND NOT s.legal_hold AND NOT coalesce(s.retention_until > now(), false)
        GROUP BY p.external_mongo_id
        ORDER BY min(s.updated_at), p.external_mongo_id
        LIMIT $2`,
      [org.rows[0].id, limit],
    );
    return rows.rows.map((row) => row.external_mongo_id);
  });

export const finishStrandedProposalPurges = async (input: {
  /** Organizations to leave exactly as they are (the blocked ones). */
  excludedOrganizationMongoIds: ReadonlySet<string>;
  limit?: number;
}): Promise<StrandedPurgeRun> => {
  const run: StrandedPurgeRun = { organizations: 0, completed: 0, incomplete: 0, leftAlone: 0 };
  if (!postgresEnabled()) return run;
  let budget = input.limit ?? runLimit();

  const tenants = await Organization.find({ status: "active" }).select("_id").lean<{ _id: unknown }[]>();
  for (const organizationMongoId of tenants.map((row) => String(row._id))) {
    if (budget <= 0) break;
    if (input.excludedOrganizationMongoIds.has(organizationMongoId)) continue;
    try {
      const candidates = await pendingProposals(organizationMongoId, budget);
      if (!candidates.length) continue;
      run.organizations += 1;
      // A failed read here throws and skips the organization: "could not ask"
      // is never taken for "the proposal is gone".
      const known = await Proposal.find({ _id: { $in: candidates } })
        .select("_id purgeStartedAt")
        .lean<{ _id: unknown; purgeStartedAt?: Date | null }[]>();
      const marker = new Map(known.map((doc) => [String(doc._id), Boolean(doc.purgeStartedAt)]));
      const beingDeleted = candidates.filter((id) => marker.get(id) === true);
      const gone = candidates.filter((id) => !marker.has(id));
      run.leftAlone += candidates.length - beingDeleted.length - gone.length;
      budget -= beingDeleted.length + gone.length;

      const target = (proposalMongoId: string) => ({ proposalMongoId, organizationMongoId });
      const results = [
        ...(await purgeProposalArtifacts(beingDeleted.map(target))),
        ...(await purgeProposalArtifacts(gone.map(target), { onlyPending: true })),
      ];
      for (const result of results) {
        if (result.complete) run.completed += 1;
        else run.incomplete += 1;
      }
    } catch (error) {
      safeLog("error", "stranded_proposal_purge_failed", {
        outcome: "failure",
        errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
      });
    }
  }

  if (run.completed || run.incomplete) {
    safeLog(run.incomplete ? "error" : "info", "stranded_proposal_purges_finished", {
      outcome: run.incomplete ? "partial" : "success",
      count: run.completed,
    });
  }
  return run;
};
