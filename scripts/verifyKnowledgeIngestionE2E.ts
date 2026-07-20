import "../config/env";
import crypto from "node:crypto";
import { postgresPool } from "../config/postgres";
import { createDocumentIngestion } from "../src/modules/documentIngestion/application";
import { configuredMalwareScanner } from "../src/modules/documentIngestion/clamAvScanner";
import { postgresDocumentRepository } from "../src/modules/documentIngestion/postgresDocumentRepository";
import { s3PrivateDocumentStorage } from "../src/modules/documentIngestion/s3PrivateDocumentStorage";
import { validateBatch } from "../src/modules/knowledgeIngestion/domain";
import { knowledgeBatchRepository } from "../src/modules/knowledgeIngestion/postgresBatchRepository";
import { knowledgeDocumentRepository } from "../src/modules/knowledgeIngestion/postgresKnowledgeDocumentRepository";
import { createKnowledgeUpload } from "../src/modules/knowledgeIngestion/knowledgeUpload";
import { parseKnowledgeDocument } from "../src/modules/knowledgeIngestion/parseApplication";

const requireTestTarget = () => {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.DOCUMENT_STORAGE_BUCKET !== "rfpilot-private-test" ||
    process.env.KNOWLEDGE_INGESTION_ENABLED !== "true"
  ) {
    throw new Error("Refusing to run outside isolated Slice 2A services");
  }
};

const context = async () => {
  const result = await postgresPool().query<{
    organization: string;
    user_id: string;
  }>(`
    SELECT o.external_mongo_id organization, u.external_mongo_id user_id
    FROM rfpilot.users u
    JOIN rfpilot.organizations o ON o.id=u.organization_id
    WHERE o.status='active'
    ORDER BY u.created_at LIMIT 1
  `);
  if (!result.rows[0]) throw new Error("Slice 1C organization and user references are required");
  return result.rows[0];
};

const main = async () => {
  requireTestTarget();
  const ids = await context();
  const correlationId = crypto.randomUUID();
  const batch = await knowledgeBatchRepository.create({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.user_id,
    correlationId,
    value: validateBatch({
      name: `Slice 2A synthetic verification ${correlationId.slice(0, 8)}`,
      sourceType: "price_sheet",
      currency: "USD",
      classification: "synthetic",
      intendedUse: "Verify the isolated knowledge-ingestion lifecycle.",
    }),
  });
  const bytes = Buffer.from(
    "Service,Unit,Rate\nSite survey,each,250\nInstallation,hour,125\n",
  );
  const upload = await createKnowledgeUpload({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.user_id,
    batchId: batch.id,
    filename: "synthetic-rates.csv",
    mimeType: "text/csv",
    sizeBytes: bytes.length,
    idempotencyKey: `slice2a-${correlationId}`,
    correlationId,
  });
  const put = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: upload.requiredHeaders,
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new Error(`Signed upload failed: ${put.status}`);
  const ingestion = createDocumentIngestion({
    repository: postgresDocumentRepository,
    storage: s3PrivateDocumentStorage,
    scanner: configuredMalwareScanner(),
  });
  await ingestion.complete({
    organizationMongoId: ids.organization,
    userMongoId: ids.user_id,
    sourceId: upload.sourceId,
    correlationId,
  });
  const scanned = await ingestion.scan({
    organizationMongoId: ids.organization,
    userMongoId: ids.user_id,
    sourceId: upload.sourceId,
    correlationId,
  });
  if (scanned.status !== "ready") throw new Error(`Expected ready source, received ${scanned.status}`);
  const document = await knowledgeDocumentRepository.attach({
    organizationMongoId: ids.organization,
    batchId: batch.id,
    sourceId: upload.sourceId,
  });
  const parsed = await parseKnowledgeDocument({
    organizationMongoId: ids.organization,
    documentId: document.id,
  });
  const fragments = await knowledgeDocumentRepository.fragments(
    ids.organization,
    document.id,
    100,
  );
  const completed = await knowledgeBatchRepository.find(ids.organization, batch.id);
  if (
    completed.status !== "needs_review" ||
    parsed.fragmentCount < 1 ||
    fragments.length !== parsed.fragmentCount
  ) {
    throw new Error("Slice 2A lifecycle assertions failed");
  }
  console.log(JSON.stringify({
    batchId: batch.id,
    documentId: document.id,
    sourceStatus: scanned.status,
    batchStatus: completed.status,
    parserRunId: parsed.runId,
    fragmentCount: parsed.fragmentCount,
    duplicateCount: parsed.duplicateCount,
  }, null, 2));
};

void main()
  .finally(async () => postgresPool().end())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
