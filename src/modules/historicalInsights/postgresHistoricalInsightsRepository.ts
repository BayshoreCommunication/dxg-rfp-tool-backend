/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import { tenantFilter } from "../shared/tenancy/tenantContext";
import {
  computeHistoricalInsights,
  HistoricalInsightsError,
  HISTORICAL_INSIGHTS_VERSION,
} from "./domain";

type Context = {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
};

const setTenant = async (client: PoolClient, externalOrganizationId: string) => {
  await client.query(
    "SELECT set_config('app.organization_mongo_id',$1,true)",
    [externalOrganizationId],
  );
  const row = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [externalOrganizationId],
  );
  if (!row.rows[0])
    throw new HistoricalInsightsError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  await client.query("SELECT set_config('app.organization_id',$1,true)", [
    row.rows[0].id,
  ]);
  return row.rows[0].id;
};

const proposalReferences = async (
  client: PoolClient,
  externalIds: string[],
  actorUserMongoId: string,
) => {
  const rows = await client.query<{ id: string; external_mongo_id: string }>(
    `SELECT p.id,p.external_mongo_id
       FROM rfpilot.proposal_references p
       JOIN rfpilot.users u ON u.id=p.owner_user_id
      WHERE p.external_mongo_id=ANY($1::varchar[])
        AND u.external_mongo_id=$2
        AND u.status='active'`,
    [externalIds, actorUserMongoId],
  );
  const byExternalId = new Map(
    rows.rows.map((row) => [row.external_mongo_id, row.id]),
  );
  if (externalIds.some((id) => !byExternalId.has(id)))
    throw new HistoricalInsightsError(
      "HISTORICAL_REFERENCE_UNAVAILABLE",
      "One or more selected historical proposals are unavailable.",
      409,
    );
  return byExternalId;
};

const loadActiveOwned = async (
  externalIds: string[],
  actorUserMongoId: string,
) => {
  const proposals = await Proposal.find({
    _id: { $in: externalIds },
    userId: actorUserMongoId,
    ...tenantFilter(),
    isArchived: { $ne: true },
  })
    .select(
      "version event venueSchedule roomByRoom hybridVirtual contentCreative venue budget isArchived",
    )
    .lean<any[]>();
  const byId = new Map(proposals.map((proposal) => [String(proposal._id), proposal]));
  if (externalIds.some((id) => !byId.has(id)))
    throw new HistoricalInsightsError(
      "HISTORICAL_REFERENCE_UNAVAILABLE",
      "One or more selected historical proposals are unavailable.",
      409,
    );
  return externalIds.map((id) => byId.get(id) as Record<string, unknown>);
};

const present = (row: any) => ({
  id: row.id,
  analysisVersion: row.analysis_version,
  currentProposalVersion: Number(row.current_proposal_version),
  references: row.reference_summary,
  comparisons: row.section_comparisons,
  insights: row.insights,
  privacy: row.privacy_summary,
  createdAt: row.created_at,
});

export const historicalInsightsRepository = {
  async generate(
    context: Context & {
      currentProposalMongoId: string;
      referenceProposalMongoIds: string[];
    },
  ) {
    const externalIds = [
      context.currentProposalMongoId,
      ...context.referenceProposalMongoIds,
    ];
    // Mongo ownership, organization and archive state are checked immediately
    // before computation. PostgreSQL references are checked again in the same
    // transaction that persists the structured result.
    const [current, ...references] = await loadActiveOwned(
      externalIds,
      context.actorUserMongoId,
    );
    const result = computeHistoricalInsights(
      current,
      references.map((proposal) => ({
        proposal,
        proposalVersion: Number(proposal.version || 1),
      })),
    );

    return withPostgresTransaction(async (client) => {
      const organizationId = await setTenant(
        client,
        context.organizationMongoId,
      );
      const refs = await proposalReferences(
        client,
        externalIds,
        context.actorUserMongoId,
      );
      const reportId = uuidv7();
      const inserted = await client.query<any>(
        `INSERT INTO rfpilot.historical_insight_reports(
          id,organization_id,current_proposal_reference_id,actor_external_user_id,
          current_proposal_version,analysis_version,reference_summary,
          section_comparisons,insights,privacy_summary,correlation_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)
        RETURNING *`,
        [
          reportId,
          organizationId,
          refs.get(context.currentProposalMongoId),
          context.actorUserMongoId,
          result.currentProposalVersion,
          HISTORICAL_INSIGHTS_VERSION,
          JSON.stringify(result.references),
          JSON.stringify(result.comparisons),
          JSON.stringify(result.insights),
          JSON.stringify(result.privacy),
          context.correlationId,
        ],
      );
      for (let index = 0; index < context.referenceProposalMongoIds.length; index += 1) {
        const externalId = context.referenceProposalMongoIds[index];
        await client.query(
          `INSERT INTO rfpilot.historical_insight_report_references(
             organization_id,report_id,reference_proposal_reference_id,ordinal
           ) VALUES($1,$2,$3,$4)`,
          [organizationId, reportId, refs.get(externalId), index + 1],
        );
      }
      await client.query(
        `INSERT INTO rfpilot.audit_events(
          id,organization_id,actor_external_user_id,action,target_type,target_id,
          decision,correlation_id,metadata
        ) VALUES($1,$2,$3,'historical_insights_generated','proposal',$4,'allowed',$5,$6::jsonb)`,
        [
          uuidv7(),
          organizationId,
          context.actorUserMongoId,
          refs.get(context.currentProposalMongoId),
          context.correlationId,
          JSON.stringify({
            referenceCount: context.referenceProposalMongoIds.length,
            insightCount: result.insights.length,
            analysisVersion: HISTORICAL_INSIGHTS_VERSION,
          }),
        ],
      );
      return present(inserted.rows[0]);
    });
  },

  async latest(
    context: Context & { currentProposalMongoId: string },
  ) {
    await loadActiveOwned(
      [context.currentProposalMongoId],
      context.actorUserMongoId,
    );
    return withPostgresTransaction(async (client) => {
      await setTenant(client, context.organizationMongoId);
      const currentRef = await proposalReferences(
        client,
        [context.currentProposalMongoId],
        context.actorUserMongoId,
      );
      const report = await client.query<any>(
        `SELECT * FROM rfpilot.historical_insight_reports
          WHERE current_proposal_reference_id=$1
            AND analysis_version=$2
          ORDER BY created_at DESC LIMIT 1`,
        [currentRef.get(context.currentProposalMongoId), HISTORICAL_INSIGHTS_VERSION],
      );
      if (!report.rows[0])
        throw new HistoricalInsightsError(
          "HISTORICAL_INSIGHTS_NOT_FOUND",
          "No historical insight report exists for this proposal yet.",
          404,
        );
      const linked = await client.query<{ external_mongo_id: string }>(
        `SELECT p.external_mongo_id
           FROM rfpilot.historical_insight_report_references l
           JOIN rfpilot.proposal_references p
             ON p.id=l.reference_proposal_reference_id
          WHERE l.report_id=$1
          ORDER BY l.ordinal`,
        [report.rows[0].id],
      );
      // Revalidate every selected proposal before returning a stored report.
      await loadActiveOwned(
        linked.rows.map((row) => row.external_mongo_id),
        context.actorUserMongoId,
      );
      return present(report.rows[0]);
    });
  },
};
