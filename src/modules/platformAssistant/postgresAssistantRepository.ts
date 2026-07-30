import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import {
  canTransitionAssistantMessage,
  PlatformAssistantError,
  type AssistantCitation,
  type AssistantFeedback,
  type AssistantFeedbackReason,
  type AssistantFeedbackValue,
  type AssistantMessage,
  type AssistantMessageRole,
  type AssistantMessageStatus,
  type AssistantResponseKind,
  type AssistantThread,
  type AssistantThreadStatus,
  type PlatformAssistantContext,
} from "./domain";
import type {
  AssistantIntent,
  AssistantIntentClassification,
  AssistantIntentSource,
} from "./intentRouter";
import {
  assistantModelPrice,
  estimatedAssistantCostUsd,
} from "./evaluation";
import {
  ASSISTANT_PRODUCT_EVENT_SCHEMA_VERSION,
  assistantErrorCategory,
  assistantLatencyBucket,
  assistantOrganizationCohort,
  type AssistantCompletionOutcome,
  type AssistantProductEventInput,
} from "./productAnalytics";
import type { PlatformAssistantRepository } from "./ports";

type ThreadRow = {
  id: string;
  title: string;
  status: AssistantThreadStatus;
  message_count: number;
  idempotency_key: string | null;
  last_message_at: Date | string | null;
  deleted_at: Date | string | null;
  purge_after: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  thread_id: string;
  ordinal: number;
  role: AssistantMessageRole;
  content: string;
  status: AssistantMessageStatus;
  idempotency_key: string | null;
  provider_response_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  safe_error_code: string | null;
  intent: AssistantIntent | null;
  intent_version: string | null;
  intent_source: AssistantIntentSource | null;
  intent_confidence: AssistantIntentClassification["confidence"] | null;
  response_kind: AssistantResponseKind | null;
  prompt_version: string | null;
  knowledge_version: string | null;
  first_token_ms: number | null;
  completion_latency_ms: number | null;
  citations: unknown;
  feedback_value?: AssistantFeedbackValue | null;
  feedback_reason?: AssistantFeedbackReason | null;
  feedback_updated_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

type FeedbackRow = {
  id: string;
  thread_id: string;
  message_id: string;
  feedback_value: AssistantFeedbackValue;
  feedback_reason: AssistantFeedbackReason | null;
  idempotency_key: string;
  input_checksum: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type ProductEventRow = {
  id: string;
  input_checksum: string;
};

type AnalyticsMessageRow = Pick<
  MessageRow,
  | "intent"
  | "response_kind"
  | "model"
  | "prompt_version"
  | "knowledge_version"
  | "first_token_ms"
  | "completion_latency_ms"
  | "input_tokens"
  | "output_tokens"
  | "safe_error_code"
  | "citations"
>;

const ASSISTANT_ARCHIVE_RETENTION_DAYS = 30;

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toOptionalIso = (value: Date | string | null): string | null =>
  value === null ? null : toIso(value);

const mapThread = (row: ThreadRow): AssistantThread => ({
  id: row.id,
  title: row.title,
  status: row.status,
  messageCount: Number(row.message_count),
  lastMessageAt: toOptionalIso(row.last_message_at),
  deletedAt: toOptionalIso(row.deleted_at),
  purgeAfter: toOptionalIso(row.purge_after),
  recoverable:
    row.deleted_at !== null &&
    row.purge_after !== null &&
    new Date(row.purge_after).getTime() > Date.now(),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapCitation = (value: unknown): AssistantCitation | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sourceId !== "string" || typeof record.title !== "string") return null;
  return {
    sourceId: record.sourceId,
    title: record.title,
    ...(typeof record.href === "string" ? { href: record.href } : {}),
    ...(typeof record.releaseId === "string" ? { releaseId: record.releaseId } : {}),
    ...(typeof record.fragmentId === "string" ? { fragmentId: record.fragmentId } : {}),
  };
};

const mapMessage = (row: MessageRow): AssistantMessage => ({
  id: row.id,
  threadId: row.thread_id,
  ordinal: Number(row.ordinal),
  role: row.role,
  content: row.content,
  status: row.status,
  providerResponseId: row.provider_response_id,
  model: row.model,
  inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
  outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
  safeErrorCode: row.safe_error_code,
  intent: row.intent,
  intentVersion: row.intent_version,
  intentSource: row.intent_source,
  intentConfidence: row.intent_confidence,
  responseKind: row.response_kind ?? null,
  promptVersion: row.prompt_version ?? null,
  knowledgeVersion: row.knowledge_version ?? null,
  firstTokenMs:
    row.first_token_ms == null ? null : Number(row.first_token_ms),
  completionLatencyMs:
    row.completion_latency_ms == null
      ? null
      : Number(row.completion_latency_ms),
  citations: Array.isArray(row.citations)
    ? row.citations.flatMap((item) => {
        const citation = mapCitation(item);
        return citation ? [citation] : [];
      })
    : [],
  feedback:
    row.feedback_value && row.feedback_updated_at
      ? {
          value: row.feedback_value,
          reason: row.feedback_reason ?? null,
          updatedAt: toIso(row.feedback_updated_at),
        }
      : null,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
  completedAt: toOptionalIso(row.completed_at),
});

const mapFeedback = (row: FeedbackRow): AssistantFeedback => ({
  id: row.id,
  threadId: row.thread_id,
  messageId: row.message_id,
  value: row.feedback_value,
  reason: row.feedback_reason,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const analyticsPseudonym = (value: string, length: 16 | 32): string => {
  const configured = String(
    process.env.AI_ANALYTICS_PSEUDONYM_KEY ||
      process.env.TELEMETRY_PSEUDONYM_KEY ||
      "",
  );
  if (
    process.env.NODE_ENV === "production" &&
    process.env.AI_ASSISTANT_ANALYTICS_ENABLED === "true" &&
    configured.length < 32
  ) {
    throw new PlatformAssistantError(
      "ASSISTANT_ANALYTICS_NOT_CONFIGURED",
      "Assistant analytics is not configured.",
      503,
    );
  }
  return crypto
    .createHmac(
      "sha256",
      configured || "test-only-assistant-analytics-key",
    )
    .update(value)
    .digest("hex")
    .slice(0, length);
};

const boundedAnalyticsString = (
  value: string | null | undefined,
): string | null => {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 100 ? normalized : null;
};

const completionOutcome = (
  input: AssistantProductEventInput,
): AssistantCompletionOutcome | null => {
  if (input.completionOutcome) return input.completionOutcome;
  switch (input.eventType) {
    case "response_completed":
    case "analysis_completed":
    case "field_change_applied":
    case "feedback_submitted":
      return "completed";
    case "response_failed":
      return "failed";
    case "response_retried":
      return "retried";
    case "citation_opened":
    case "internal_route_opened":
    case "proposal_handoff_started":
    case "proposal_handoff_completed":
      return "navigated";
    case "suggestion_selected":
    case "finding_reviewed":
    case "field_change_proposed":
      return "selected";
    case "suggestion_shown":
      return "shown";
    case "assistant_opened":
      return "opened";
    default:
      return null;
  }
};

const resolveTenant = async (
  client: PoolClient,
  context: PlatformAssistantContext,
): Promise<string> => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    context.organizationMongoId,
  ]);
  const organization = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [context.organizationMongoId],
  );
  if (!organization.rows[0]) {
    throw new PlatformAssistantError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  }
  const organizationId = organization.rows[0].id;
  await client.query("SELECT set_config('app.organization_id',$1,true)", [
    organizationId,
  ]);
  const actor = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.users WHERE organization_id=$1 AND external_mongo_id=$2 AND status='active'",
    [organizationId, context.actorUserMongoId],
  );
  if (!actor.rows[0]) {
    throw new PlatformAssistantError(
      "ASSISTANT_ACTOR_NOT_READY",
      "Your assistant workspace is not ready.",
      503,
    );
  }
  return organizationId;
};

const audit = (
  client: PoolClient,
  input: {
    organizationId: string;
    actorUserMongoId: string;
    action: string;
    targetType: string;
    targetId: string;
    correlationId: string;
    metadata?: Record<string, unknown>;
  },
) =>
  client.query(
    `INSERT INTO rfpilot.audit_events(
       id,organization_id,actor_external_user_id,action,target_type,target_id,
       decision,correlation_id,metadata
     ) VALUES($1,$2,$3,$4,$5,$6,'allowed',$7,$8::jsonb)`,
    [
      uuidv7(),
      input.organizationId,
      input.actorUserMongoId,
      input.action,
      input.targetType,
      input.targetId,
      input.correlationId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

const ownedThread = async (
  client: PoolClient,
  input: {
    threadId: string;
    actorUserMongoId: string;
    forUpdate?: boolean;
    includeDeleted?: boolean;
  },
): Promise<ThreadRow> => {
  const result = await client.query<ThreadRow>(
    `SELECT id,title,status,message_count,idempotency_key,last_message_at,
            deleted_at,purge_after,created_at,updated_at
     FROM rfpilot.assistant_threads
     WHERE id=$1 AND owner_external_user_id=$2
       ${input.includeDeleted ? "" : "AND deleted_at IS NULL"}
     ${input.forUpdate ? "FOR UPDATE" : ""}`,
    [input.threadId, input.actorUserMongoId],
  );
  if (!result.rows[0]) {
    throw new PlatformAssistantError(
      "ASSISTANT_THREAD_NOT_FOUND",
      "The assistant conversation was not found.",
      404,
    );
  }
  return result.rows[0];
};

const assertThreadActive = (thread: ThreadRow): void => {
  if (thread.status !== "active") {
    throw new PlatformAssistantError(
      "ASSISTANT_THREAD_ARCHIVED",
      "This assistant conversation is archived.",
      409,
    );
  }
};

const appendMessage = async (
  client: PoolClient,
  input: PlatformAssistantContext & {
    organizationId: string;
    thread: ThreadRow;
    role: Extract<AssistantMessageRole, "user" | "assistant">;
    content: string;
    status: AssistantMessageStatus;
    idempotencyKey: string;
    intent?: AssistantIntentClassification;
  },
): Promise<{ created: boolean; message: AssistantMessage }> => {
  const existing = await client.query<MessageRow>(
    `SELECT * FROM rfpilot.assistant_messages
     WHERE thread_id=$1 AND idempotency_key=$2`,
    [input.thread.id, input.idempotencyKey],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (
      row.role !== input.role ||
      (input.role === "user" && row.content !== input.content)
    ) {
      throw new PlatformAssistantError(
        "ASSISTANT_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different assistant request.",
        409,
      );
    }
    return { created: false, message: mapMessage(row) };
  }

  const ordinal = Number(input.thread.message_count) + 1;
  const inserted = await client.query<MessageRow>(
    `INSERT INTO rfpilot.assistant_messages(
       id,organization_id,thread_id,ordinal,role,content,status,idempotency_key,
       actor_external_user_id,intent,intent_version,intent_source,intent_confidence
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      uuidv7(),
      input.organizationId,
      input.thread.id,
      ordinal,
      input.role,
      input.content,
      input.status,
      input.idempotencyKey,
      input.role === "user" ? input.actorUserMongoId : null,
      input.intent?.intent ?? null,
      input.intent?.version ?? null,
      input.intent?.source ?? null,
      input.intent?.confidence ?? null,
    ],
  );
  await client.query(
    `UPDATE rfpilot.assistant_threads
     SET message_count=$2,last_message_at=now(),updated_at=now()
     WHERE id=$1`,
    [input.thread.id, ordinal],
  );
  await audit(client, {
    organizationId: input.organizationId,
    actorUserMongoId: input.actorUserMongoId,
    action: "assistant.message.create",
    targetType: "assistant_message",
    targetId: inserted.rows[0].id,
    correlationId: input.correlationId,
    metadata: {
      role: input.role,
      threadId: input.thread.id,
      ...(input.intent
        ? {
            intent: input.intent.intent,
            intentVersion: input.intent.version,
            intentSource: input.intent.source,
            intentConfidence: input.intent.confidence,
          }
        : {}),
    },
  });
  return { created: true, message: mapMessage(inserted.rows[0]) };
};

export const postgresAssistantRepository: PlatformAssistantRepository = {
  createThread(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      const existing = await client.query<ThreadRow>(
        `SELECT id,title,status,message_count,idempotency_key,last_message_at,
                deleted_at,purge_after,created_at,updated_at
         FROM rfpilot.assistant_threads
         WHERE owner_external_user_id=$1 AND idempotency_key=$2
           AND deleted_at IS NULL`,
        [input.actorUserMongoId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].title !== input.title) {
          throw new PlatformAssistantError(
            "ASSISTANT_IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for a different assistant request.",
            409,
          );
        }
        return { created: false, thread: mapThread(existing.rows[0]) };
      }
      const inserted = await client.query<ThreadRow>(
        `INSERT INTO rfpilot.assistant_threads(
           id,organization_id,owner_external_user_id,title,idempotency_key
         ) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (
           organization_id,owner_external_user_id,idempotency_key
         ) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id,title,status,message_count,idempotency_key,last_message_at,
                   deleted_at,purge_after,created_at,updated_at`,
        [
          uuidv7(),
          organizationId,
          input.actorUserMongoId,
          input.title,
          input.idempotencyKey,
        ],
      );
      if (!inserted.rows[0]) {
        const replay = await client.query<ThreadRow>(
          `SELECT id,title,status,message_count,idempotency_key,last_message_at,
                  deleted_at,purge_after,created_at,updated_at
           FROM rfpilot.assistant_threads
           WHERE owner_external_user_id=$1 AND idempotency_key=$2
             AND deleted_at IS NULL`,
          [input.actorUserMongoId, input.idempotencyKey],
        );
        if (!replay.rows[0] || replay.rows[0].title !== input.title) {
          throw new PlatformAssistantError(
            "ASSISTANT_IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for a different assistant request.",
            409,
          );
        }
        return { created: false, thread: mapThread(replay.rows[0]) };
      }
      await audit(client, {
        organizationId,
        actorUserMongoId: input.actorUserMongoId,
        action: "assistant.thread.create",
        targetType: "assistant_thread",
        targetId: inserted.rows[0].id,
        correlationId: input.correlationId,
      });
      return { created: true, thread: mapThread(inserted.rows[0]) };
    });
  },

  listThreads(input) {
    return withPostgresTransaction(async (client) => {
      await resolveTenant(client, input);
      const deletionPredicate =
        input.deletionState === "deleted"
          ? "deleted_at IS NOT NULL"
          : "deleted_at IS NULL";
      const result = input.updatedBefore
        ? await client.query<ThreadRow>(
            `SELECT id,title,status,message_count,idempotency_key,last_message_at,
                    deleted_at,purge_after,created_at,updated_at
             FROM rfpilot.assistant_threads
             WHERE owner_external_user_id=$1
               AND ${deletionPredicate}
               AND updated_at<$2
             ORDER BY updated_at DESC,id DESC LIMIT $3`,
            [input.actorUserMongoId, input.updatedBefore, input.limit],
          )
        : await client.query<ThreadRow>(
            `SELECT id,title,status,message_count,idempotency_key,last_message_at,
                    deleted_at,purge_after,created_at,updated_at
             FROM rfpilot.assistant_threads
             WHERE owner_external_user_id=$1
               AND ${deletionPredicate}
             ORDER BY updated_at DESC,id DESC LIMIT $2`,
            [input.actorUserMongoId, input.limit],
          );
      return result.rows.map(mapThread);
    });
  },

  getThread(input) {
    return withPostgresTransaction(async (client) => {
      await resolveTenant(client, input);
      const thread = await ownedThread(client, input);
      const messages = input.beforeOrdinal
        ? await client.query<MessageRow>(
            `SELECT m.*,f.feedback_value,f.feedback_reason,
                    f.updated_at AS feedback_updated_at
             FROM rfpilot.assistant_messages m
             LEFT JOIN rfpilot.assistant_feedback f
               ON f.organization_id=m.organization_id
              AND f.message_id=m.id
              AND f.actor_external_user_id=$2
             WHERE m.thread_id=$1 AND m.ordinal<$3
             ORDER BY m.ordinal DESC LIMIT $4`,
            [
              thread.id,
              input.actorUserMongoId,
              input.beforeOrdinal,
              input.messageLimit,
            ],
          )
        : await client.query<MessageRow>(
            `SELECT m.*,f.feedback_value,f.feedback_reason,
                    f.updated_at AS feedback_updated_at
             FROM rfpilot.assistant_messages m
             LEFT JOIN rfpilot.assistant_feedback f
               ON f.organization_id=m.organization_id
              AND f.message_id=m.id
              AND f.actor_external_user_id=$2
             WHERE m.thread_id=$1
             ORDER BY m.ordinal DESC LIMIT $3`,
            [thread.id, input.actorUserMongoId, input.messageLimit],
          );
      return {
        thread: mapThread(thread),
        messages: messages.rows.reverse().map(mapMessage),
      };
    });
  },

  archiveThread(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      const thread = await ownedThread(client, {
        ...input,
        forUpdate: true,
        includeDeleted: true,
      });
      if (thread.deleted_at) return mapThread(thread);
      const updated = await client.query<ThreadRow>(
        `UPDATE rfpilot.assistant_threads
         SET status='archived',
             deleted_at=now(),
             purge_after=now()+($3::text||' days')::interval,
             updated_at=now()
         WHERE id=$1 AND owner_external_user_id=$2 AND deleted_at IS NULL
         RETURNING id,title,status,message_count,idempotency_key,last_message_at,
                   deleted_at,purge_after,created_at,updated_at`,
        [
          thread.id,
          input.actorUserMongoId,
          ASSISTANT_ARCHIVE_RETENTION_DAYS,
        ],
      );
      await client.query(
        `INSERT INTO rfpilot.assistant_deletion_requests(
           id,organization_id,thread_id,actor_external_user_id,status,
           purge_after,correlation_id
         ) VALUES($1,$2,$3,$4,'pending',$5,$6)
         ON CONFLICT (organization_id,thread_id)
           WHERE status='pending' DO NOTHING`,
        [
          uuidv7(),
          organizationId,
          thread.id,
          input.actorUserMongoId,
          updated.rows[0].purge_after,
          input.correlationId,
        ],
      );
      await audit(client, {
        organizationId,
        actorUserMongoId: input.actorUserMongoId,
        action: "assistant.thread.archive",
        targetType: "assistant_thread",
        targetId: thread.id,
        correlationId: input.correlationId,
        metadata: {
          retentionDays: ASSISTANT_ARCHIVE_RETENTION_DAYS,
        },
      });
      return mapThread(updated.rows[0]);
    });
  },

  deleteThreadPermanently(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      const thread = await ownedThread(client, {
        ...input,
        forUpdate: true,
        includeDeleted: true,
      });

      const hold = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM rfpilot.assistant_legal_holds
           WHERE organization_id=$1
             AND status='active'
             AND (
               (resource_type='organization' AND resource_id=$1::text) OR
               (resource_type='assistant_thread' AND resource_id=$2::text)
             )
         ) AS blocked`,
        [organizationId, thread.id],
      );
      if (hold.rows[0]?.blocked) {
        throw new PlatformAssistantError(
          "ASSISTANT_THREAD_LEGAL_HOLD",
          "This conversation cannot be permanently deleted while a legal hold is active.",
          409,
        );
      }

      await client.query(
        `DELETE FROM rfpilot.assistant_feedback
         WHERE organization_id=$1 AND thread_id=$2`,
        [organizationId, thread.id],
      );
      await client.query(
        `DELETE FROM rfpilot.assistant_messages
         WHERE organization_id=$1 AND thread_id=$2`,
        [organizationId, thread.id],
      );
      await client.query(
        `DELETE FROM rfpilot.assistant_threads
         WHERE organization_id=$1
           AND id=$2
           AND owner_external_user_id=$3`,
        [organizationId, thread.id, input.actorUserMongoId],
      );
      await client.query(
        `UPDATE rfpilot.assistant_deletion_requests
         SET status='purged',purged_at=now(),updated_at=now()
         WHERE organization_id=$1 AND thread_id=$2 AND status='pending'`,
        [organizationId, thread.id],
      );
      await audit(client, {
        organizationId,
        actorUserMongoId: input.actorUserMongoId,
        action: "assistant.thread.delete.permanent",
        targetType: "assistant_thread",
        targetId: thread.id,
        correlationId: input.correlationId,
        metadata: {
          immediate: true,
          archivedBeforeDelete: thread.deleted_at !== null,
        },
      });
      return { id: thread.id, deleted: true };
    });
  },

  restoreThread(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      const thread = await ownedThread(client, {
        ...input,
        forUpdate: true,
        includeDeleted: true,
      });
      if (!thread.deleted_at) return mapThread(thread);
      if (
        !thread.purge_after ||
        new Date(thread.purge_after).getTime() <= Date.now()
      ) {
        throw new PlatformAssistantError(
          "ASSISTANT_THREAD_RECOVERY_EXPIRED",
          "This conversation can no longer be restored.",
          410,
        );
      }
      const updated = await client.query<ThreadRow>(
        `UPDATE rfpilot.assistant_threads
         SET status='active',deleted_at=NULL,purge_after=NULL,updated_at=now()
         WHERE id=$1 AND owner_external_user_id=$2
         RETURNING id,title,status,message_count,idempotency_key,last_message_at,
                   deleted_at,purge_after,created_at,updated_at`,
        [thread.id, input.actorUserMongoId],
      );
      await client.query(
        `UPDATE rfpilot.assistant_deletion_requests
         SET status='restored',restored_at=now(),updated_at=now()
         WHERE organization_id=$1 AND thread_id=$2 AND status='pending'`,
        [organizationId, thread.id],
      );
      await audit(client, {
        organizationId,
        actorUserMongoId: input.actorUserMongoId,
        action: "assistant.thread.restore",
        targetType: "assistant_thread",
        targetId: thread.id,
        correlationId: input.correlationId,
      });
      return mapThread(updated.rows[0]);
    });
  },

  appendUserMessage(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      const thread = await ownedThread(client, { ...input, forUpdate: true });
      assertThreadActive(thread);
      return appendMessage(client, {
        ...input,
        organizationId,
        thread,
        role: "user",
        status: "complete",
      });
    });
  },

  createAssistantMessage(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      const thread = await ownedThread(client, { ...input, forUpdate: true });
      assertThreadActive(thread);
      return appendMessage(client, {
        ...input,
        organizationId,
        thread,
        role: "assistant",
        content: input.content ?? "",
        status: input.status ?? "pending",
      });
    });
  },

  updateAssistantMessage(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      await ownedThread(client, input);
      const current = await client.query<MessageRow>(
        `SELECT m.* FROM rfpilot.assistant_messages m
         JOIN rfpilot.assistant_threads t ON t.id=m.thread_id
         WHERE m.id=$1 AND m.thread_id=$2 AND m.role='assistant'
           AND t.owner_external_user_id=$3
         FOR UPDATE OF m`,
        [input.messageId, input.threadId, input.actorUserMongoId],
      );
      if (!current.rows[0]) {
        throw new PlatformAssistantError(
          "ASSISTANT_MESSAGE_NOT_FOUND",
          "The assistant message was not found.",
          404,
        );
      }
      if (!canTransitionAssistantMessage(current.rows[0].status, input.status)) {
        throw new PlatformAssistantError(
          "INVALID_ASSISTANT_MESSAGE_STATE",
          "The assistant message can no longer be updated.",
          409,
        );
      }
      const terminal = ["complete", "failed", "aborted"].includes(input.status);
      const updated = await client.query<MessageRow>(
        `UPDATE rfpilot.assistant_messages
         SET status=$2,content=$3,citations=$4::jsonb,provider_response_id=$5,
             model=$6,input_tokens=$7,output_tokens=$8,safe_error_code=$9,
             intent=COALESCE($10,intent),
             intent_version=COALESCE($11,intent_version),
             intent_source=COALESCE($12,intent_source),
             intent_confidence=COALESCE($13,intent_confidence),
             response_kind=COALESCE($14,response_kind),
             prompt_version=COALESCE($15,prompt_version),
             knowledge_version=COALESCE($16,knowledge_version),
             first_token_ms=COALESCE($17,first_token_ms),
             completion_latency_ms=COALESCE($18,completion_latency_ms),
             completed_at=CASE WHEN $19 THEN COALESCE(completed_at,now()) ELSE NULL END,
             updated_at=now()
         WHERE id=$1
         RETURNING *`,
        [
          input.messageId,
          input.status,
          input.content,
          JSON.stringify(input.citations ?? []),
          input.providerResponseId ?? null,
          input.model ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.safeErrorCode ?? null,
          input.intent?.intent ?? null,
          input.intent?.version ?? null,
          input.intent?.source ?? null,
          input.intent?.confidence ?? null,
          input.responseKind ?? null,
          input.promptVersion ?? null,
          input.knowledgeVersion ?? null,
          input.firstTokenMs ?? null,
          input.completionLatencyMs ?? null,
          terminal,
        ],
      );
      await client.query(
        "UPDATE rfpilot.assistant_threads SET last_message_at=now(),updated_at=now() WHERE id=$1",
        [input.threadId],
      );
      if (terminal) {
        await audit(client, {
          organizationId,
          actorUserMongoId: input.actorUserMongoId,
          action: "assistant.message.finish",
          targetType: "assistant_message",
          targetId: input.messageId,
          correlationId: input.correlationId,
          metadata: { status: input.status, threadId: input.threadId },
        });
      }
      return mapMessage(updated.rows[0]);
    });
  },

  submitFeedback(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      await ownedThread(client, input);
      const message = await client.query<MessageRow>(
        `SELECT m.* FROM rfpilot.assistant_messages m
         JOIN rfpilot.assistant_threads t
           ON t.organization_id=m.organization_id AND t.id=m.thread_id
         WHERE m.organization_id=$1 AND m.thread_id=$2 AND m.id=$3
           AND m.role='assistant' AND m.status='complete'
           AND t.owner_external_user_id=$4
         FOR UPDATE OF m`,
        [
          organizationId,
          input.threadId,
          input.messageId,
          input.actorUserMongoId,
        ],
      );
      if (!message.rows[0]) {
        throw new PlatformAssistantError(
          "ASSISTANT_MESSAGE_NOT_FOUND",
          "The completed assistant message was not found.",
          404,
        );
      }
      const inputChecksum = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            messageId: input.messageId,
            value: input.value,
            reason: input.reason,
          }),
        )
        .digest("hex");
      const replay = await client.query<FeedbackRow>(
        `SELECT * FROM rfpilot.assistant_feedback
         WHERE organization_id=$1 AND actor_external_user_id=$2
           AND idempotency_key=$3`,
        [organizationId, input.actorUserMongoId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].input_checksum !== inputChecksum) {
          throw new PlatformAssistantError(
            "ASSISTANT_IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for different feedback.",
            409,
          );
        }
        return {
          created: false,
          feedback: mapFeedback(replay.rows[0]),
        };
      }
      const existing = await client.query<FeedbackRow>(
        `SELECT * FROM rfpilot.assistant_feedback
         WHERE organization_id=$1 AND actor_external_user_id=$2
           AND message_id=$3
         FOR UPDATE`,
        [organizationId, input.actorUserMongoId, input.messageId],
      );
      const citedSourceIds = Array.isArray(message.rows[0].citations)
        ? [
            ...new Set(
              message.rows[0].citations.flatMap((item) => {
                const citation = mapCitation(item);
                return citation ? [citation.sourceId.slice(0, 300)] : [];
              }),
            ),
          ].slice(0, 12)
        : [];
      const values = [
        input.value,
        input.reason,
        message.rows[0].intent,
        message.rows[0].response_kind ?? "legacy_unclassified",
        message.rows[0].model,
        message.rows[0].prompt_version,
        message.rows[0].knowledge_version,
        citedSourceIds,
        message.rows[0].first_token_ms,
        message.rows[0].completion_latency_ms,
        input.idempotencyKey,
        inputChecksum,
      ] as const;
      const saved = existing.rows[0]
        ? await client.query<FeedbackRow>(
            `UPDATE rfpilot.assistant_feedback
             SET feedback_value=$2,feedback_reason=$3,intent=$4,
                 response_kind=$5,model=$6,prompt_version=$7,
                 knowledge_version=$8,cited_source_ids=$9,
                 first_token_ms=$10,completion_latency_ms=$11,
                 idempotency_key=$12,input_checksum=$13,updated_at=now()
             WHERE id=$1
             RETURNING *`,
            [existing.rows[0].id, ...values],
          )
        : await client.query<FeedbackRow>(
            `INSERT INTO rfpilot.assistant_feedback(
               id,organization_id,thread_id,message_id,
               actor_external_user_id,feedback_value,feedback_reason,intent,
               response_kind,model,prompt_version,knowledge_version,
               cited_source_ids,first_token_ms,completion_latency_ms,
               idempotency_key,input_checksum
             ) VALUES(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
             )
             RETURNING *`,
            [
              uuidv7(),
              organizationId,
              input.threadId,
              input.messageId,
              input.actorUserMongoId,
              ...values,
            ],
          );
      await audit(client, {
        organizationId,
        actorUserMongoId: input.actorUserMongoId,
        action: existing.rows[0]
          ? "assistant.feedback.update"
          : "assistant.feedback.create",
        targetType: "assistant_feedback",
        targetId: saved.rows[0].id,
        correlationId: input.correlationId,
        metadata: {
          feedbackValue: input.value,
          feedbackReason: input.reason,
          intent: message.rows[0].intent,
          responseKind:
            message.rows[0].response_kind ?? "legacy_unclassified",
          promptVersion: message.rows[0].prompt_version,
          knowledgeVersion: message.rows[0].knowledge_version,
          citedSourceCount: citedSourceIds.length,
        },
      });
      return {
        created: !existing.rows[0],
        feedback: mapFeedback(saved.rows[0]),
      };
    });
  },

  recordProductEvent(input) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await resolveTenant(client, input);
      if (input.threadId) {
        await ownedThread(client, {
          threadId: input.threadId,
          actorUserMongoId: input.actorUserMongoId,
        });
      }
      let message: AnalyticsMessageRow | null = null;
      if (input.messageId) {
        if (!input.threadId) {
          throw new PlatformAssistantError(
            "INVALID_ASSISTANT_ANALYTICS_EVENT",
            "A message event requires its conversation.",
            422,
          );
        }
        const result = await client.query<AnalyticsMessageRow>(
          `SELECT m.intent,m.response_kind,m.model,m.prompt_version,
                  m.knowledge_version,m.first_token_ms,
                  m.completion_latency_ms,m.input_tokens,m.output_tokens,
                  m.safe_error_code,m.citations
           FROM rfpilot.assistant_messages m
           JOIN rfpilot.assistant_threads t
             ON t.organization_id=m.organization_id AND t.id=m.thread_id
           WHERE m.organization_id=$1 AND m.thread_id=$2 AND m.id=$3
             AND t.owner_external_user_id=$4`,
          [
            organizationId,
            input.threadId,
            input.messageId,
            input.actorUserMongoId,
          ],
        );
        message = result.rows[0] ?? null;
        if (!message) {
          throw new PlatformAssistantError(
            "ASSISTANT_MESSAGE_NOT_FOUND",
            "The assistant message was not found.",
            404,
          );
        }
      }

      const sessionReference =
        input.analyticsSessionId ||
        input.sessionId ||
        input.threadId;
      if (!sessionReference) {
        throw new PlatformAssistantError(
          "INVALID_ASSISTANT_ANALYTICS_SESSION",
          "The assistant analytics session is required.",
          422,
        );
      }
      const actorPseudonym = analyticsPseudonym(
        `${organizationId}:${input.actorUserMongoId}`,
        16,
      );
      const sessionKey = analyticsPseudonym(
        `${organizationId}:${input.actorUserMongoId}:${sessionReference}`,
        32,
      );
      const firstTokenMs =
        input.firstTokenMs ?? message?.first_token_ms ?? null;
      const completionLatencyMs =
        input.completionLatencyMs ??
        message?.completion_latency_ms ??
        null;
      const latencyValue =
        input.eventType === "first_token_received"
          ? firstTokenMs
          : completionLatencyMs ?? firstTokenMs;
      const citations = Array.isArray(message?.citations)
        ? message.citations
        : [];
      const inputTokens =
        input.inputTokens ?? message?.input_tokens ?? null;
      const outputTokens =
        input.outputTokens ?? message?.output_tokens ?? null;
      const price = message?.model
        ? assistantModelPrice(message.model)
        : null;
      const estimatedCostMicros =
        input.estimatedCostMicros ??
        (price && inputTokens !== null && outputTokens !== null
          ? Math.round(
              estimatedAssistantCostUsd(
                Number(inputTokens),
                Number(outputTokens),
                price,
              ) * 1_000_000,
            )
          : null);
      const values = {
        eventSchemaVersion: ASSISTANT_PRODUCT_EVENT_SCHEMA_VERSION,
        eventType: input.eventType,
        organizationCohort: assistantOrganizationCohort(),
        routeCategory: input.routeCategory ?? null,
        intent: message?.intent ?? input.intent ?? null,
        responseKind:
          message?.response_kind ?? input.responseKind ?? null,
        model: boundedAnalyticsString(message?.model ?? input.model),
        promptVersion: boundedAnalyticsString(
          message?.prompt_version ?? input.promptVersion,
        ),
        knowledgeVersion: boundedAnalyticsString(
          message?.knowledge_version ?? input.knowledgeVersion,
        ),
        ruleVersion: boundedAnalyticsString(input.ruleVersion),
        pricingVersion: boundedAnalyticsString(input.pricingVersion),
        cited: input.cited ?? (message ? citations.length > 0 : null),
        latencyBucket: assistantLatencyBucket(latencyValue),
        firstTokenMs:
          firstTokenMs === null ? null : Number(firstTokenMs),
        completionLatencyMs:
          completionLatencyMs === null
            ? null
            : Number(completionLatencyMs),
        inputTokens:
          inputTokens === null ? null : Number(inputTokens),
        outputTokens:
          outputTokens === null ? null : Number(outputTokens),
        estimatedCostMicros,
        errorCategory: assistantErrorCategory(
          input.errorCode ?? message?.safe_error_code,
        ),
        findingCategory: input.findingCategory ?? null,
        completionOutcome: completionOutcome(input),
        feedbackValue: input.feedbackValue ?? null,
        feedbackReason: input.feedbackReason ?? null,
      };
      const inputChecksum = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            actorPseudonym,
            sessionKey,
            ...values,
          }),
        )
        .digest("hex");
      const inserted = await client.query<ProductEventRow>(
        `INSERT INTO rfpilot.assistant_product_events(
           id,organization_id,actor_pseudonym,session_key,
           event_schema_version,event_type,organization_cohort,
           route_category,intent,response_kind,model,prompt_version,
           knowledge_version,rule_version,pricing_version,cited,
           latency_bucket,first_token_ms,completion_latency_ms,
           input_tokens,output_tokens,estimated_cost_micros,error_category,
           finding_category,completion_outcome,feedback_value,feedback_reason,
           idempotency_key,input_checksum
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
         )
         ON CONFLICT (
           organization_id,actor_pseudonym,idempotency_key
         ) DO NOTHING
         RETURNING id,input_checksum`,
        [
          uuidv7(),
          organizationId,
          actorPseudonym,
          sessionKey,
          values.eventSchemaVersion,
          values.eventType,
          values.organizationCohort,
          values.routeCategory,
          values.intent,
          values.responseKind,
          values.model,
          values.promptVersion,
          values.knowledgeVersion,
          values.ruleVersion,
          values.pricingVersion,
          values.cited,
          values.latencyBucket,
          values.firstTokenMs,
          values.completionLatencyMs,
          values.inputTokens,
          values.outputTokens,
          values.estimatedCostMicros,
          values.errorCategory,
          values.findingCategory,
          values.completionOutcome,
          values.feedbackValue,
          values.feedbackReason,
          input.idempotencyKey,
          inputChecksum,
        ],
      );
      if (inserted.rows[0]) return { created: true };
      const replay = await client.query<ProductEventRow>(
        `SELECT id,input_checksum
         FROM rfpilot.assistant_product_events
         WHERE organization_id=$1 AND actor_pseudonym=$2
           AND idempotency_key=$3`,
        [organizationId, actorPseudonym, input.idempotencyKey],
      );
      if (!replay.rows[0] || replay.rows[0].input_checksum !== inputChecksum) {
        throw new PlatformAssistantError(
          "ASSISTANT_IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for a different analytics event.",
          409,
        );
      }
      return { created: false };
    });
  },
};
