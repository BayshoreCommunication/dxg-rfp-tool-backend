import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import {
  canTransitionAssistantMessage,
  PlatformAssistantError,
  type AssistantCitation,
  type AssistantMessage,
  type AssistantMessageRole,
  type AssistantMessageStatus,
  type AssistantThread,
  type AssistantThreadStatus,
  type PlatformAssistantContext,
} from "./domain";
import type {
  AssistantIntent,
  AssistantIntentClassification,
  AssistantIntentSource,
} from "./intentRouter";
import type { PlatformAssistantRepository } from "./ports";

type ThreadRow = {
  id: string;
  title: string;
  status: AssistantThreadStatus;
  message_count: number;
  idempotency_key: string | null;
  last_message_at: Date | string | null;
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
  citations: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

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
  citations: Array.isArray(row.citations)
    ? row.citations.flatMap((item) => {
        const citation = mapCitation(item);
        return citation ? [citation] : [];
      })
    : [],
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
  completedAt: toOptionalIso(row.completed_at),
});

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
  },
): Promise<ThreadRow> => {
  const result = await client.query<ThreadRow>(
    `SELECT id,title,status,message_count,idempotency_key,last_message_at,created_at,updated_at
     FROM rfpilot.assistant_threads
     WHERE id=$1 AND owner_external_user_id=$2
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
        `SELECT id,title,status,message_count,idempotency_key,last_message_at,created_at,updated_at
         FROM rfpilot.assistant_threads
         WHERE owner_external_user_id=$1 AND idempotency_key=$2`,
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
         RETURNING id,title,status,message_count,idempotency_key,last_message_at,created_at,updated_at`,
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
          `SELECT id,title,status,message_count,idempotency_key,last_message_at,created_at,updated_at
           FROM rfpilot.assistant_threads
           WHERE owner_external_user_id=$1 AND idempotency_key=$2`,
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
      const result = input.updatedBefore
        ? await client.query<ThreadRow>(
            `SELECT id,title,status,message_count,idempotency_key,last_message_at,created_at,updated_at
             FROM rfpilot.assistant_threads
             WHERE owner_external_user_id=$1 AND updated_at<$2
             ORDER BY updated_at DESC,id DESC LIMIT $3`,
            [input.actorUserMongoId, input.updatedBefore, input.limit],
          )
        : await client.query<ThreadRow>(
            `SELECT id,title,status,message_count,idempotency_key,last_message_at,created_at,updated_at
             FROM rfpilot.assistant_threads
             WHERE owner_external_user_id=$1
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
            `SELECT * FROM rfpilot.assistant_messages
             WHERE thread_id=$1 AND ordinal<$2
             ORDER BY ordinal DESC LIMIT $3`,
            [thread.id, input.beforeOrdinal, input.messageLimit],
          )
        : await client.query<MessageRow>(
            `SELECT * FROM rfpilot.assistant_messages
             WHERE thread_id=$1
             ORDER BY ordinal DESC LIMIT $2`,
            [thread.id, input.messageLimit],
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
      const thread = await ownedThread(client, { ...input, forUpdate: true });
      if (thread.status === "archived") return mapThread(thread);
      const updated = await client.query<ThreadRow>(
        `UPDATE rfpilot.assistant_threads
         SET status='archived',updated_at=now()
         WHERE id=$1 AND owner_external_user_id=$2
         RETURNING id,title,status,message_count,idempotency_key,last_message_at,created_at,updated_at`,
        [thread.id, input.actorUserMongoId],
      );
      await audit(client, {
        organizationId,
        actorUserMongoId: input.actorUserMongoId,
        action: "assistant.thread.archive",
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
             completed_at=CASE WHEN $14 THEN COALESCE(completed_at,now()) ELSE NULL END,
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
};
