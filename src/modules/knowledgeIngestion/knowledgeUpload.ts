import path from "node:path";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { validateUpload } from "../documentIngestion/domain";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { KnowledgeIngestionError } from "./domain";
const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    external,
  ]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0])
    throw new KnowledgeIngestionError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  await c.query("SELECT set_config('app.organization_id',$1,true)", [
    r.rows[0].id,
  ]);
  return r.rows[0].id;
};
export const createKnowledgeUpload = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  batchId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  idempotencyKey: string;
  correlationId: string;
}) => {
  const valid = validateUpload(
    input.filename,
    input.mimeType,
    input.sizeBytes,
    50 * 1024 * 1024,
  );
  if (!input.idempotencyKey)
    throw new KnowledgeIngestionError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key is required.",
      400,
    );
  const created = await withPostgresTransaction(async (c) => {
    const org = await tenant(c, input.organizationMongoId);
    const batch = await c.query<{ status: string; classification: string }>(
      "SELECT status,classification FROM rfpilot.knowledge_import_batches WHERE id=$1",
      [input.batchId],
    );
    if (!batch.rows[0])
      throw new KnowledgeIngestionError(
        "BATCH_NOT_FOUND",
        "Import batch was not found.",
        404,
      );
    if (!["draft", "parse_queued", "parsing", "needs_review"].includes(batch.rows[0].status))
      throw new KnowledgeIngestionError(
        "INVALID_BATCH_STATE",
        "Files cannot be uploaded in the current batch state.",
        409,
      );
    const prior = await c.query<{ aggregate_id: string }>(
      "SELECT aggregate_id FROM rfpilot.outbox_events WHERE organization_id=$1 AND idempotency_key=$2",
      [org, `knowledge.upload:${input.idempotencyKey}`],
    );
    if (prior.rows[0]) {
      const object = await c.query<{ object_key: string; source_id: string }>(
        "SELECT object_key,source_id FROM rfpilot.document_objects WHERE source_id=$1",
        [prior.rows[0].aggregate_id],
      );
      return {
        sourceId: object.rows[0].source_id,
        objectKey: object.rows[0].object_key,
        created: false,
      };
    }
    const sourceId = uuidv7(),
      objectId = uuidv7();
    const extension = path.extname(valid.filename).toLowerCase();
    const objectKey = `quarantine/${input.organizationMongoId}/knowledge/${sourceId}/original${extension}`;
    const confidentiality =
      batch.rows[0].classification === "internal" ||
      batch.rows[0].classification === "synthetic"
        ? "internal"
        : "confidential";
    await c.query(
      "INSERT INTO rfpilot.document_sources(id,organization_id,uploader_external_user_id,purpose,confidentiality) VALUES($1,$2,$3,'organization_knowledge',$4)",
      [sourceId, org, input.actorUserMongoId, confidentiality],
    );
    await c.query(
      "INSERT INTO rfpilot.document_objects(id,organization_id,source_id,object_key,original_filename,safe_filename,declared_mime_type,expected_size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        objectId,
        org,
        sourceId,
        objectKey,
        input.filename.slice(0, 255),
        valid.filename,
        valid.mimeType,
        input.sizeBytes,
      ],
    );
    await c.query(
      "INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'document_source',$3,'knowledge.upload_session_created',$4,$5::jsonb)",
      [
        uuidv7(),
        org,
        sourceId,
        `knowledge.upload:${input.idempotencyKey}`,
        JSON.stringify({
          sourceId,
          batchId: input.batchId,
          correlationId: input.correlationId,
        }),
      ],
    );
    return { sourceId, objectKey, created: true };
  });
  const signed = await s3PrivateDocumentStorage.createUpload({
    objectKey: created.objectKey,
    contentType: valid.mimeType,
    sizeBytes: input.sizeBytes,
    expiresSeconds: 900,
  });
  return {
    sourceId: created.sourceId,
    created: created.created,
    ...signed,
    requiredHeaders: { "content-type": valid.mimeType },
  };
};
