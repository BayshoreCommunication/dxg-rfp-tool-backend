import { createDocumentIngestion } from "./application";
import { configuredMalwareScanner } from "./clamAvScanner";
import { postgresDocumentRepository } from "./postgresDocumentRepository";
import { s3PrivateDocumentStorage } from "./s3PrivateDocumentStorage";

export const documentIngestionEnabled = () => process.env.DOCUMENT_INGESTION_ENABLED === "true";
export const documentIngestion = createDocumentIngestion({
  repository: postgresDocumentRepository,
  storage: s3PrivateDocumentStorage,
  scanner: configuredMalwareScanner(),
  maxBytes: Number(process.env.DOCUMENT_MAX_FILE_BYTES || 50 * 1024 * 1024),
  uploadTtlSeconds: Number(process.env.DOCUMENT_UPLOAD_TTL_SECONDS || 900),
});
