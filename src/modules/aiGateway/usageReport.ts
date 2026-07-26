/* eslint-disable @typescript-eslint/no-explicit-any */
import { withPostgresTransaction } from "../../../config/postgres";
import { AiGatewayError } from "./domain";

// Content-free provider usage aggregation for cost reconciliation: attempt
// counts, outcomes and token sums per day/provider/model, plus lifetime
// totals. No prompts, outputs or identifiers beyond the caller's own org.
export const aiUsageReport = async (input: { organizationMongoId: string; days?: number }) => {
  const days = Math.min(Math.max(input.days ?? 30, 1), 90);
  return withPostgresTransaction(async (c) => {
    await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [input.organizationMongoId]);
    const org = await c.query<{ id: string }>(
      "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
      [input.organizationMongoId],
    );
    if (!org.rows[0]) throw new AiGatewayError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
    await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
    const daily = await c.query<any>(
      `SELECT date_trunc('day',created_at)::date AS day,provider,model,state,count(*)::int AS attempts,
              coalesce(sum(input_tokens),0)::bigint AS input_tokens,coalesce(sum(output_tokens),0)::bigint AS output_tokens
       FROM rfpilot.ai_provider_attempts WHERE organization_id=$1 AND created_at>now()-($2||' days')::interval
       GROUP BY 1,2,3,4 ORDER BY 1 DESC,2,3,4`,
      [org.rows[0].id, days],
    );
    const totals = await c.query<any>(
      `SELECT provider,count(*)::int AS attempts,
              count(*) FILTER (WHERE state='succeeded')::int AS succeeded,
              count(*) FILTER (WHERE state IN('failed','orphaned'))::int AS failed_or_orphaned,
              coalesce(sum(input_tokens),0)::bigint AS input_tokens,coalesce(sum(output_tokens),0)::bigint AS output_tokens
       FROM rfpilot.ai_provider_attempts WHERE organization_id=$1 GROUP BY provider`,
      [org.rows[0].id],
    );
    const operations = await c.query<any>(
      `SELECT run_type,operation,state,count(*)::int AS attempts,
              coalesce(sum(input_tokens),0)::bigint AS input_tokens,
              coalesce(sum(output_tokens),0)::bigint AS output_tokens
       FROM rfpilot.ai_provider_attempts WHERE organization_id=$1 AND created_at>now()-($2||' days')::interval
       GROUP BY run_type,operation,state ORDER BY run_type,operation,state`,
      [org.rows[0].id, days],
    );
    const recentAttempts = await c.query<any>(
      `SELECT id,run_type,run_id,attempt_number,state,provider,model,operation,
              input_tokens,output_tokens,error_code,created_at,updated_at
       FROM rfpilot.ai_provider_attempts WHERE organization_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [org.rows[0].id],
    );
    return {
      windowDays: days,
      daily: daily.rows.map((row) => ({
        day: row.day, provider: row.provider, model: row.model, state: row.state,
        attempts: row.attempts, inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      })),
      totals: totals.rows.map((row) => ({
        provider: row.provider, attempts: row.attempts, succeeded: row.succeeded,
        failedOrOrphaned: row.failed_or_orphaned, inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      })),
      operations: operations.rows.map((row) => ({
        runType: row.run_type, operation: row.operation, state: row.state,
        attempts: row.attempts, inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      })),
      recentAttempts: recentAttempts.rows.map((row) => ({
        id: row.id, runType: row.run_type, runId: row.run_id,
        attemptNumber: row.attempt_number, state: row.state, provider: row.provider,
        model: row.model, operation: row.operation, inputTokens: row.input_tokens,
        outputTokens: row.output_tokens, errorCode: row.error_code,
        createdAt: row.created_at, updatedAt: row.updated_at,
      })),
      note: "Token counts come from the provider attempt ledger; reconcile against the provider invoice. Vendor-analysis calls are not yet ledgered.",
    };
  });
};
