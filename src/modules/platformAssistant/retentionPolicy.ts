import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../../../config/postgres";
import { PlatformAssistantError } from "./domain";

export const ASSISTANT_RETENTION_POLICY_VERSION =
  "assistant-retention-policy.v1";

export const ASSISTANT_RETENTION_RESOURCES = [
  {
    resource: "conversations",
    storage: "assistant_threads",
    policy: "conversation_retention_days",
    cleanup: "soft_delete_then_purge",
  },
  {
    resource: "messages_and_citations",
    storage: "assistant_messages",
    policy: "conversation_retention_days",
    cleanup: "with_parent_conversation",
  },
  {
    resource: "feedback",
    storage: "assistant_feedback",
    policy: "feedback_retention_days",
    cleanup: "with_parent_conversation_or_policy_window",
  },
  {
    resource: "analytics_metadata",
    storage: "assistant_product_events",
    policy: "analytics_retention_days",
    cleanup: "content_free_policy_window",
  },
  {
    resource: "proposal_analyses_and_findings",
    storage: "guidance_reports",
    policy: "analysis_retention_days",
    cleanup: "policy_preview_only_until_dependency_review",
  },
  {
    resource: "historical_reference_links",
    storage: "historical_insight_reports",
    policy: "analysis_retention_days",
    cleanup: "policy_preview_only_until_dependency_review",
  },
  {
    resource: "field_change_proposals",
    storage: "candidate_applications",
    policy: "analysis_retention_days",
    cleanup: "existing_retention_until_and_dependency_order",
  },
  {
    resource: "audit_records",
    storage: "audit_events",
    policy: "audit_retention_days",
    cleanup: "preserve_until_separate_compliance_approval",
  },
] as const;

type ApprovedPolicyRow = {
  conversation_retention_days: number;
  deletion_grace_days: number;
  feedback_retention_days: number;
  analytics_retention_days: number;
  analysis_retention_days: number;
  audit_retention_days: number;
  provider_storage_mode: "application_managed" | "provider_zero_retention";
  policy_version: string;
};

export type AssistantRetentionPreview = {
  organizationId: string;
  policy: ApprovedPolicyRow | null;
  executable: boolean;
  blockedReason: string | null;
  eligible: {
    conversations: number;
    analyticsEvents: number;
    proposalAnalyses: number;
    historicalInsights: number;
    fieldChangeApplications: number;
    auditRecords: number;
  };
};

const number = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const resolveOrganization = async (
  client: PoolClient,
  organizationMongoId: string,
): Promise<string> => {
  if (!/^[0-9a-f]{24}$/.test(organizationMongoId)) {
    throw new PlatformAssistantError(
      "INVALID_ORGANIZATION",
      "The organization identifier is invalid.",
      422,
    );
  }
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    organizationMongoId,
  ]);
  const result = await client.query<{ id: string }>(
    `SELECT id FROM rfpilot.organizations
     WHERE external_mongo_id=$1`,
    [organizationMongoId],
  );
  if (!result.rows[0]) {
    throw new PlatformAssistantError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      404,
    );
  }
  await client.query("SELECT set_config('app.organization_id',$1,true)", [
    result.rows[0].id,
  ]);
  return result.rows[0].id;
};

const approvedPolicy = async (
  client: PoolClient,
  organizationId: string,
): Promise<ApprovedPolicyRow | null> => {
  const result = await client.query<ApprovedPolicyRow>(
    `SELECT conversation_retention_days,deletion_grace_days,
            feedback_retention_days,analytics_retention_days,
            analysis_retention_days,audit_retention_days,
            provider_storage_mode,policy_version
     FROM rfpilot.assistant_retention_policies
     WHERE organization_id=$1 AND status='approved'`,
    [organizationId],
  );
  return result.rows[0] ?? null;
};

const count = async (
  client: PoolClient,
  sql: string,
  values: unknown[],
): Promise<number> => {
  const result = await client.query<{ count: string }>(sql, values);
  return number(result.rows[0]?.count);
};

const organizationHoldSql = `
  NOT EXISTS (
    SELECT 1 FROM rfpilot.assistant_legal_holds hold
    WHERE hold.organization_id=$1
      AND hold.status='active'
      AND hold.resource_type='organization'
      AND hold.resource_id=$1::text
  )
`;

export const previewAssistantRetention = (
  organizationMongoId: string,
): Promise<AssistantRetentionPreview> =>
  withPostgresTransaction(async (client) => {
    const organizationId = await resolveOrganization(
      client,
      organizationMongoId,
    );
    const policy = await approvedPolicy(client, organizationId);
    if (!policy) {
      return {
        organizationId,
        policy: null,
        executable: false,
        blockedReason: "No approved retention policy exists.",
        eligible: {
          conversations: 0,
          analyticsEvents: 0,
          proposalAnalyses: 0,
          historicalInsights: 0,
          fieldChangeApplications: 0,
          auditRecords: 0,
        },
      };
    }
    const conversations = await count(
      client,
      `SELECT count(*)::text AS count
       FROM rfpilot.assistant_threads thread
       WHERE thread.organization_id=$1
         AND thread.deleted_at IS NOT NULL
         AND thread.purge_after<=now()
         AND ${organizationHoldSql}
         AND NOT EXISTS (
           SELECT 1 FROM rfpilot.assistant_legal_holds hold
           WHERE hold.organization_id=$1
             AND hold.status='active'
             AND hold.resource_type='assistant_thread'
             AND hold.resource_id=thread.id::text
         )`,
      [organizationId],
    );
    const analyticsEvents = await count(
      client,
      `SELECT count(*)::text AS count
       FROM rfpilot.assistant_product_events
       WHERE organization_id=$1
         AND occurred_at<now()-($2::text||' days')::interval
         AND ${organizationHoldSql}`,
      [organizationId, policy.analytics_retention_days],
    );
    const proposalAnalyses = await count(
      client,
      `SELECT count(*)::text AS count FROM rfpilot.guidance_reports
       WHERE organization_id=$1
         AND created_at<now()-($2::text||' days')::interval
         AND ${organizationHoldSql}`,
      [organizationId, policy.analysis_retention_days],
    );
    const historicalInsights = await count(
      client,
      `SELECT count(*)::text AS count
       FROM rfpilot.historical_insight_reports
       WHERE organization_id=$1
         AND created_at<now()-($2::text||' days')::interval
         AND ${organizationHoldSql}`,
      [organizationId, policy.analysis_retention_days],
    );
    const fieldChangeApplications = await count(
      client,
      `SELECT count(*)::text AS count FROM rfpilot.candidate_applications
       WHERE organization_id=$1 AND retention_until<=now()
         AND ${organizationHoldSql}`,
      [organizationId],
    );
    const auditRecords = await count(
      client,
      `SELECT count(*)::text AS count FROM rfpilot.audit_events
       WHERE organization_id=$1
         AND created_at<now()-($2::text||' days')::interval
         AND ${organizationHoldSql}`,
      [organizationId, policy.audit_retention_days],
    );
    return {
      organizationId,
      policy,
      executable: true,
      blockedReason: null,
      eligible: {
        conversations,
        analyticsEvents,
        proposalAnalyses,
        historicalInsights,
        fieldChangeApplications,
        auditRecords,
      },
    };
  });

export const assistantRetentionExecutionAuthorized = (): boolean => {
  if (
    process.env.AI_RETENTION_PURGE_ENABLED !== "true" ||
    process.env.AI_RETENTION_POLICY_APPROVED !== "true"
  ) {
    return false;
  }
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.AI_RETENTION_PRODUCTION_EXECUTION_APPROVED === "true"
  );
};

export const executeAssistantRetention = (
  organizationMongoId: string,
): Promise<{
  purgedConversations: number;
  purgedAnalyticsEvents: number;
}> => {
  if (!assistantRetentionExecutionAuthorized()) {
    throw new PlatformAssistantError(
      "ASSISTANT_RETENTION_EXECUTION_DISABLED",
      "Retention cleanup is in dry-run mode.",
      403,
    );
  }
  return withPostgresTransaction(async (client) => {
    const organizationId = await resolveOrganization(
      client,
      organizationMongoId,
    );
    const policy = await approvedPolicy(client, organizationId);
    if (!policy) {
      throw new PlatformAssistantError(
        "ASSISTANT_RETENTION_POLICY_NOT_APPROVED",
        "An approved retention policy is required.",
        409,
      );
    }
    const eligibleSql = `
      SELECT thread.id
      FROM rfpilot.assistant_threads thread
      WHERE thread.organization_id=$1
        AND thread.deleted_at IS NOT NULL
        AND thread.purge_after<=now()
        AND ${organizationHoldSql}
        AND NOT EXISTS (
          SELECT 1 FROM rfpilot.assistant_legal_holds hold
          WHERE hold.organization_id=$1
            AND hold.status='active'
            AND hold.resource_type='assistant_thread'
            AND hold.resource_id=thread.id::text
        )
    `;
    await client.query(
      `DELETE FROM rfpilot.assistant_feedback
       WHERE organization_id=$1 AND thread_id IN (${eligibleSql})`,
      [organizationId],
    );
    await client.query(
      `DELETE FROM rfpilot.assistant_messages
       WHERE organization_id=$1 AND thread_id IN (${eligibleSql})`,
      [organizationId],
    );
    const conversations = await client.query(
      `DELETE FROM rfpilot.assistant_threads
       WHERE organization_id=$1 AND id IN (${eligibleSql})
       RETURNING id`,
      [organizationId],
    );
    if (conversations.rows.length > 0) {
      await client.query(
        `UPDATE rfpilot.assistant_deletion_requests
         SET status='purged',purged_at=now(),updated_at=now()
         WHERE organization_id=$1 AND status='pending'
           AND thread_id=ANY($2::uuid[])`,
        [
          organizationId,
          conversations.rows.map((row: { id: string }) => row.id),
        ],
      );
    }
    const analytics = await client.query(
      `DELETE FROM rfpilot.assistant_product_events
       WHERE organization_id=$1
         AND occurred_at<now()-($2::text||' days')::interval
         AND ${organizationHoldSql}
       RETURNING id`,
      [organizationId, policy.analytics_retention_days],
    );
    return {
      purgedConversations: conversations.rowCount ?? 0,
      purgedAnalyticsEvents: analytics.rowCount ?? 0,
    };
  });
};
