import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../../../config/postgres";
import {
  beginProviderAttempt,
  completeProviderAttempt,
  type ProviderAttemptContext,
} from "../liveAi/attemptLedger";
import { PlatformAssistantError } from "./domain";

export type AssistantAttemptHandle = {
  id: string;
  fingerprint: string;
  attemptNumber: number;
  context: ProviderAttemptContext;
};

export type AssistantAttemptOutcome = {
  state: "succeeded" | "failed";
  inputTokens?: number | null;
  outputTokens?: number | null;
  providerRequestId?: string | null;
  errorCode?: string | null;
};

export interface AssistantAttemptLedger {
  begin(input: {
    organizationMongoId: string;
    assistantMessageId: string;
    provider: "openai";
    model: string;
  }): Promise<AssistantAttemptHandle>;
  complete(
    attempt: AssistantAttemptHandle,
    outcome: AssistantAttemptOutcome,
  ): Promise<void>;
}

const resolveOrganizationId = (
  organizationMongoId: string,
): Promise<string> =>
  withPostgresTransaction(async (client: PoolClient) => {
    await client.query(
      "SELECT set_config('app.organization_mongo_id',$1,true)",
      [organizationMongoId],
    );
    const result = await client.query<{ id: string }>(
      `SELECT id
       FROM rfpilot.organizations
       WHERE external_mongo_id=$1 AND status='active'`,
      [organizationMongoId],
    );
    if (!result.rows[0]) {
      throw new PlatformAssistantError(
        "ORGANIZATION_NOT_READY",
        "Organization data foundation is unavailable.",
        503,
      );
    }
    return result.rows[0].id;
  });

export const postgresAssistantAttemptLedger: AssistantAttemptLedger = {
  async begin(input) {
    const context: ProviderAttemptContext = {
      runType: "platform_assistant",
      runId: input.assistantMessageId,
      organizationId: await resolveOrganizationId(input.organizationMongoId),
    };
    const attempt = await beginProviderAttempt(context, {
      provider: input.provider,
      model: input.model,
      operation: "generateFromEvidence",
    });
    return { ...attempt, context };
  },

  complete(attempt, outcome) {
    return completeProviderAttempt(attempt.context, attempt.id, outcome);
  },
};
