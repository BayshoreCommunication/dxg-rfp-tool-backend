import { withPostgresTransaction } from "../../../config/postgres";
import {
  ProposalContextError,
  PROPOSAL_CONTEXT_INPUT_VERSION,
} from "./domain";

export const latestProposalContextRunId = (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
}) =>
  withPostgresTransaction(async (client) => {
    await client.query(
      "SELECT set_config('app.organization_mongo_id',$1,true)",
      [input.organizationMongoId],
    );
    const organization = await client.query<{ id: string }>(
      "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
      [input.organizationMongoId],
    );
    if (!organization.rows[0])
      throw new ProposalContextError(
        "ORGANIZATION_NOT_READY",
        "Organization data foundation is unavailable.",
        503,
      );
    await client.query("SELECT set_config('app.organization_id',$1,true)", [
      organization.rows[0].id,
    ]);
    const result = await client.query<{ id: string }>(
      `SELECT r.id
         FROM rfpilot.proposal_context_runs r
         JOIN rfpilot.ai_jobs j
           ON j.id=r.job_id AND j.input_version=$3
         JOIN rfpilot.proposal_references p ON p.id=r.proposal_reference_id
         JOIN rfpilot.users u ON u.id=p.owner_user_id
        WHERE p.external_mongo_id=$1
          AND u.external_mongo_id=$2
          AND r.status='succeeded'
          AND r.retention_until>now()
        ORDER BY r.created_at DESC LIMIT 1`,
      [
        input.proposalMongoId,
        input.actorUserMongoId,
        PROPOSAL_CONTEXT_INPUT_VERSION,
      ],
    );
    if (!result.rows[0])
      throw new ProposalContextError(
        "CONTEXT_RUN_UNAVAILABLE",
        "No completed context run is available.",
        404,
      );
    return result.rows[0].id;
  });
