/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import {
  computeGuidance,
  GuidanceError,
  PROPOSAL_ANALYSIS_VERSION,
} from "./domain";

type Ctx = { organizationMongoId: string; actorUserMongoId: string; correlationId: string };

const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [external]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0]) throw new GuidanceError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
  await c.query("SELECT set_config('app.organization_id',$1,true)", [r.rows[0].id]);
  return r.rows[0].id;
};
const proposalRef = async (c: PoolClient, id: string, actor: string) => {
  const r = await c.query<{ id: string }>(
    "SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'",
    [id, actor],
  );
  if (!r.rows[0]) throw new GuidanceError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return r.rows[0].id;
};

const present = (row: any, currentProposalVersion = Number(row.proposal_version)) => ({
  id: row.id,
  proposalVersion: row.proposal_version,
  currentProposalVersion,
  stale:
    Number(row.proposal_version) !== currentProposalVersion ||
    row.engine_version !== PROPOSAL_ANALYSIS_VERSION,
  analysisVersion: row.engine_version,
  engineVersion: row.engine_version,
  summary: row.summary ?? {},
  roomSchedule: row.room_schedule_analysis ?? {},
  overallCompleteness: Number(row.overall_completeness),
  completeness: row.completeness,
  findings: row.findings,
  findingCount: row.finding_count,
  blockingCount: row.blocking_count,
  createdAt: row.created_at,
});

export const guidanceRepository = {
  // Guidance is a cheap deterministic computation over the owner's proposal,
  // persisted for auditability and workflow readiness. No model calls.
  async generate(ctx: Ctx & { proposalMongoId: string }) {
    const proposal = await Proposal.findOne({ _id: ctx.proposalMongoId, userId: ctx.actorUserMongoId })
      .lean<any>();
    if (!proposal) throw new GuidanceError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
    const proposalVersion = Number(proposal.version || 1);
    const result = computeGuidance(proposal, { proposalVersion });
    const blockingCount = result.findings.filter((f) => f.severity === "blocking").length;
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const p = await proposalRef(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const row = await c.query<any>(
        `INSERT INTO rfpilot.guidance_reports(id,organization_id,proposal_reference_id,actor_external_user_id,proposal_version,engine_version,summary,room_schedule_analysis,overall_completeness,completeness,findings,finding_count,blocking_count,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12,$13,$14) RETURNING *`,
        [
          uuidv7(), org, p, ctx.actorUserMongoId, proposalVersion,
          PROPOSAL_ANALYSIS_VERSION, JSON.stringify(result.summary),
          JSON.stringify(result.roomSchedule), result.overall,
          JSON.stringify(result.completeness), JSON.stringify(result.findings),
          result.findings.length, blockingCount, ctx.correlationId,
        ],
      );
      await c.query(
        "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,'guidance_report_generated','proposal',$4,'allowed',$5,$6::jsonb)",
        [uuidv7(), org, ctx.actorUserMongoId, p, ctx.correlationId, JSON.stringify({ count: result.findings.length, outcome: blockingCount ? "blocking" : "clear" })],
      );
      return present(row.rows[0], proposalVersion);
    });
  },
  async latest(ctx: Ctx & { proposalMongoId: string }) {
    const proposal = await Proposal.findOne({
      _id: ctx.proposalMongoId,
      userId: ctx.actorUserMongoId,
    })
      .select("version")
      .lean<{ version?: number }>();
    if (!proposal) throw new GuidanceError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
    const currentProposalVersion = Number(proposal.version || 1);
    return withPostgresTransaction(async (c) => {
      await tenant(c, ctx.organizationMongoId);
      const p = await proposalRef(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const row = await c.query<any>(
        "SELECT * FROM rfpilot.guidance_reports WHERE proposal_reference_id=$1 AND engine_version=$2 ORDER BY created_at DESC LIMIT 1",
        [p, PROPOSAL_ANALYSIS_VERSION],
      );
      if (!row.rows[0]) throw new GuidanceError("GUIDANCE_NOT_FOUND", "No guidance report exists for this proposal yet.", 404);
      return present(row.rows[0], currentProposalVersion);
    });
  },
};
