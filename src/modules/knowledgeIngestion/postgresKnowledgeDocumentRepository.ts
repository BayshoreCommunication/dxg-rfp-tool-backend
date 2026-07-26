import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
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
export const knowledgeDocumentRepository = {
  attach(input: {
    organizationMongoId: string;
    batchId: string;
    sourceId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      const batch = await c.query<{ status: string }>(
        "SELECT status FROM rfpilot.knowledge_import_batches WHERE id=$1",
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
          "Files cannot be attached in the current batch state.",
          409,
        );
      const source = await c.query<{ status: string; sha256: string | null }>(
        `SELECT s.status,o.sha256 FROM rfpilot.document_sources s JOIN rfpilot.document_objects o ON o.source_id=s.id WHERE s.id=$1 AND s.purpose='organization_knowledge'`,
        [input.sourceId],
      );
      if (!source.rows[0])
        throw new KnowledgeIngestionError(
          "SOURCE_NOT_FOUND",
          "Knowledge source was not found.",
          404,
        );
      if (source.rows[0].status !== "ready")
        throw new KnowledgeIngestionError(
          "SOURCE_NOT_CLEAN",
          "Only validated, malware-scanned sources may be attached.",
          409,
        );
      const existing = await c.query<{ id: string }>(
        "SELECT id FROM rfpilot.knowledge_import_documents WHERE batch_id=$1 AND document_source_id=$2",
        [input.batchId, input.sourceId],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
      const count = await c.query<{ count: string }>(
        "SELECT count(*) count FROM rfpilot.knowledge_import_documents WHERE batch_id=$1",
        [input.batchId],
      );
      if (Number(count.rows[0].count) >= 20)
        throw new KnowledgeIngestionError(
          "BATCH_FILE_LIMIT",
          "A test batch may contain at most 20 files.",
          422,
        );
      const id = uuidv7();
      await c.query(
        "INSERT INTO rfpilot.knowledge_import_documents(id,organization_id,batch_id,document_source_id,status,sha256) VALUES($1,$2,$3,$4,'parse_queued',$5)",
        [id, org, input.batchId, input.sourceId, source.rows[0].sha256],
      );
      await c.query(
        "UPDATE rfpilot.knowledge_import_batches SET status='parse_queued',updated_at=now() WHERE id=$1",
        [input.batchId],
      );
      return { id, created: true };
    });
  },
  fragments(org: string, documentId: string, limit: number) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, org);
      const r = await c.query<{
        id: string;
        ordinal: number;
        content: string;
        coordinates: object;
        checksum: string;
        review_status: string;
      }>(
        "SELECT id,ordinal,content,coordinates,checksum,review_status FROM rfpilot.knowledge_source_fragments WHERE document_id=$1 ORDER BY ordinal LIMIT $2",
        [documentId, limit],
      );
      return r.rows.map((x) => ({
        id: x.id,
        ordinal: x.ordinal,
        content: x.content,
        coordinates: x.coordinates,
        checksum: x.checksum.trim(),
        reviewStatus: x.review_status,
      }));
    });
  },
};
