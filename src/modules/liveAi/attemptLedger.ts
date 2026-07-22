import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";

// Billing-safety ledger for live provider calls. Each attempt is committed in
// its own transaction BEFORE the provider is invoked, so a worker crash after
// the call leaves a durable 'pending_call' row (later marked 'orphaned') and a
// retried run cannot silently re-charge the provider without an audit trail.
export type ProviderAttemptContext = {
  runType: "proposal_context" | "proposal_draft" | "conversation_chat" | "vendor_response_analyze";
  runId: string;
  organizationId: string;
};

export type ProviderAttempt = { id: string; fingerprint: string; attemptNumber: number };

const tenant = async (c: PoolClient, organizationId: string) => {
  await c.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
};

export const beginProviderAttempt = async (
  ctx: ProviderAttemptContext,
  call: { provider: string; model: string; operation: "extractStructured" | "generateFromEvidence" },
): Promise<ProviderAttempt> =>
  withPostgresTransaction(async (c) => {
    await tenant(c, ctx.organizationId);
    await c.query(
      "UPDATE rfpilot.ai_provider_attempts SET state='orphaned',updated_at=now() WHERE run_type=$1 AND run_id=$2 AND state='pending_call'",
      [ctx.runType, ctx.runId],
    );
    const prior = await c.query<{ n: number }>(
      "SELECT count(*)::int n FROM rfpilot.ai_provider_attempts WHERE run_type=$1 AND run_id=$2",
      [ctx.runType, ctx.runId],
    );
    const attemptNumber = Number(prior.rows[0]?.n ?? 0) + 1;
    const id = uuidv7();
    const fingerprint = `${ctx.runType}:${ctx.runId}:${attemptNumber}`;
    await c.query(
      "INSERT INTO rfpilot.ai_provider_attempts(id,organization_id,run_type,run_id,attempt_number,attempt_fingerprint,state,provider,model,operation) VALUES($1,$2,$3,$4,$5,$6,'pending_call',$7,$8,$9)",
      [id, ctx.organizationId, ctx.runType, ctx.runId, attemptNumber, fingerprint, call.provider, call.model, call.operation],
    );
    return { id, fingerprint, attemptNumber };
  });

export const completeProviderAttempt = async (
  ctx: ProviderAttemptContext,
  attemptId: string,
  outcome: {
    state: "succeeded" | "failed";
    inputTokens?: number | null;
    outputTokens?: number | null;
    providerRequestId?: string | null;
    errorCode?: string | null;
  },
): Promise<void> =>
  withPostgresTransaction(async (c) => {
    await tenant(c, ctx.organizationId);
    await c.query(
      "UPDATE rfpilot.ai_provider_attempts SET state=$2,input_tokens=$3,output_tokens=$4,provider_request_id=$5,error_code=$6,updated_at=now() WHERE id=$1",
      [attemptId, outcome.state, outcome.inputTokens ?? null, outcome.outputTokens ?? null, outcome.providerRequestId ?? null, outcome.errorCode ?? null],
    );
  });
