import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { postgresDocumentRepository } from "../documentIngestion/postgresDocumentRepository";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { deterministicParser } from "./deterministicParser";
import { KnowledgeIngestionError } from "./domain";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const tenant = async (c: import("pg").PoolClient, external: string) => {
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
export const parseKnowledgeDocument = async (input: {
  organizationMongoId: string;
  documentId: string;
}) => {
  const metadata = await withPostgresTransaction(async (c) => {
    await tenant(c, input.organizationMongoId);
    const r = await c.query<{
      source_id: string;
      status: string;
      declared_mime_type: string;
    }>(
      `SELECT d.document_source_id source_id,d.status,o.declared_mime_type FROM rfpilot.knowledge_import_documents d JOIN rfpilot.document_objects o ON o.source_id=d.document_source_id WHERE d.id=$1`,
      [input.documentId],
    );
    if (!r.rows[0])
      throw new KnowledgeIngestionError(
        "KNOWLEDGE_DOCUMENT_NOT_FOUND",
        "Knowledge document was not found.",
        404,
      );
    if (!["parse_queued", "failed"].includes(r.rows[0].status))
      throw new KnowledgeIngestionError(
        "INVALID_KNOWLEDGE_DOCUMENT_STATE",
        "Knowledge document is not ready to parse.",
        409,
      );
    await c.query(
      "UPDATE rfpilot.knowledge_import_documents SET status='parsing',updated_at=now() WHERE id=$1",
      [input.documentId],
    );
    return r.rows[0];
  });
  try {
    const source = await postgresDocumentRepository.get(
      input.organizationMongoId,
      metadata.source_id,
    );
    if (source.status !== "ready")
      throw new KnowledgeIngestionError(
        "SOURCE_NOT_CLEAN",
        "Only validated, malware-scanned sources may be parsed.",
        409,
      );
    const object = await s3PrivateDocumentStorage.read({
      objectKey: source.objectKey,
      maxBytes: 50 * 1024 * 1024,
    });
    const parsed = await deterministicParser.parse(
      object.bytes,
      metadata.declared_mime_type,
    );
    return await withPostgresTransaction(async (c) => {
    const org = await tenant(c, input.organizationMongoId);
    const runId = uuidv7();
    await c.query(
      "INSERT INTO rfpilot.knowledge_parser_runs(id,organization_id,document_id,parser_kind,parser_version,status,fragment_count,started_at,completed_at) VALUES($1,$2,$3,$4,$5,'succeeded',$6,now(),now())",
      [
        runId,
        org,
        input.documentId,
        parsed.parserKind,
        parsed.parserVersion,
        parsed.fragments.length,
      ],
    );
    let duplicates = 0;
    for (const f of parsed.fragments) {
      const duplicate = await c.query(
        "SELECT 1 FROM rfpilot.knowledge_source_fragments WHERE organization_id=$1 AND checksum=$2 LIMIT 1",
        [org, f.checksum],
      );
      if (duplicate.rowCount) duplicates++;
      await c.query(
        "INSERT INTO rfpilot.knowledge_source_fragments(id,organization_id,document_id,parser_run_id,ordinal,content,coordinates,checksum) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
        [
          uuidv7(),
          org,
          input.documentId,
          runId,
          f.ordinal,
          f.content,
          JSON.stringify(f.coordinates),
          f.checksum,
        ],
      );
    }
    await c.query(
      "UPDATE rfpilot.knowledge_import_documents SET status='needs_review',sha256=$2,parser_kind=$3,parser_version=$4,updated_at=now() WHERE id=$1",
      [
        input.documentId,
        source.sha256,
        parsed.parserKind,
        parsed.parserVersion,
      ],
    );
    await c.query(
      `UPDATE rfpilot.knowledge_import_batches b SET status='needs_review',updated_at=now()
       WHERE b.id=(SELECT batch_id FROM rfpilot.knowledge_import_documents WHERE id=$1)
       AND NOT EXISTS(SELECT 1 FROM rfpilot.knowledge_import_documents d WHERE d.batch_id=b.id AND d.status<>'needs_review')`,
      [input.documentId],
    );
    return {
      runId,
      fragmentCount: parsed.fragments.length,
      duplicateCount: duplicates,
    };
    });
  } catch (error) {
    await withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      await c.query(
        "UPDATE rfpilot.knowledge_import_documents SET status='failed',updated_at=now() WHERE id=$1 AND status='parsing'",
        [input.documentId],
      );
      await c.query(
        `UPDATE rfpilot.knowledge_import_batches b SET status='failed',updated_at=now()
         WHERE b.id=(SELECT batch_id FROM rfpilot.knowledge_import_documents WHERE id=$1)`,
        [input.documentId],
      );
    });
    throw error;
  }
};
