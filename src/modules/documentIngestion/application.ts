import crypto from "node:crypto";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { detectMimeType, DocumentIngestionError, validateUpload, type AllowedDocumentMime } from "./domain";
import type { DocumentRepository, MalwareScanner, PrivateDocumentStorage } from "./ports";

export const createDocumentIngestion = (deps: { repository: DocumentRepository; storage: PrivateDocumentStorage; scanner: MalwareScanner; maxBytes?: number; uploadTtlSeconds?: number; now?: () => Date }) => {
  const maxBytes = deps.maxBytes ?? 50 * 1024 * 1024;
  const uploadTtlSeconds = deps.uploadTtlSeconds ?? 900;
  const now = deps.now ?? (() => new Date());
  return {
    async createUpload(input: { organizationMongoId: string; userMongoId: string; proposalMongoId: string; filename: string; mimeType: string; sizeBytes: number; classification?: string; idempotencyKey: string; correlationId: string }) {
      const valid = validateUpload(input.filename, input.mimeType, input.sizeBytes, maxBytes);
      if (!input.idempotencyKey) throw new DocumentIngestionError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 400);
      const confidentiality=input.classification==="non_confidential"?"non_confidential":"confidential";
      const sourceId = uuidv7();
      const extension = path.extname(valid.filename).toLowerCase();
      const objectKey = `quarantine/${input.organizationMongoId}/${sourceId}/original${extension}`;
      const result = await deps.repository.create({ ...input, confidentiality, originalFilename: input.filename, safeFilename: valid.filename, mimeType: valid.mimeType, expectedSizeBytes: input.sizeBytes, objectKey, retentionUntil: null, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId });
      const upload = await deps.storage.createUpload({ objectKey: result.objectKey, contentType: valid.mimeType, sizeBytes: result.source.expectedSizeBytes, expiresSeconds: uploadTtlSeconds });
      return { source: result.source, created: result.created, ...upload, requiredHeaders: { "content-type": valid.mimeType } };
    },
    async complete(input: { organizationMongoId: string; userMongoId: string; sourceId: string; correlationId: string }) {
      const source = await deps.repository.get(input.organizationMongoId, input.sourceId);
      if (source.status !== "pending_upload") {
        if (["uploaded", "scanning", "ready", "blocked", "scan_failed"].includes(source.status)) return source;
        throw new DocumentIngestionError("INVALID_SOURCE_STATE", "This upload cannot be completed in its current state.", 409);
      }
      const object = await deps.storage.read({ objectKey: source.objectKey, maxBytes });
      if (object.sizeBytes !== source.expectedSizeBytes) throw new DocumentIngestionError("OBJECT_SIZE_MISMATCH", "Uploaded file size does not match the declared size.", 422);
      const detected = detectMimeType(object.bytes, source.mimeType as AllowedDocumentMime);
      if (!detected || detected !== source.mimeType) throw new DocumentIngestionError("CONTENT_TYPE_MISMATCH", "File content does not match the declared file type.", 415);
      const sha256 = crypto.createHash("sha256").update(object.bytes).digest("hex");
      return deps.repository.complete({ organizationMongoId: input.organizationMongoId, sourceId: input.sourceId, actualSizeBytes: object.sizeBytes, detectedMimeType: detected, sha256, storageVersion: object.versionId, actorUserMongoId: input.userMongoId, correlationId: input.correlationId });
    },
    async scan(input: { organizationMongoId: string; userMongoId: string; sourceId: string; correlationId: string }) {
      const startedAt = now();
      const pending = await deps.repository.beginScan(input.organizationMongoId, input.sourceId);
      if (pending.source.status === "ready" || pending.source.status === "blocked") return pending.source;
      let result;
      try {
        const object = await deps.storage.read({ objectKey: pending.objectKey, maxBytes });
        result = await deps.scanner.scan(object.bytes);
      } catch {
        result = { status: "unavailable" as const, scanner: "configured-scanner", diagnosticCode: "SCANNER_UNAVAILABLE" };
      }
      return deps.repository.finishScan({ organizationMongoId: input.organizationMongoId, sourceId: input.sourceId, actorUserMongoId: input.userMongoId, correlationId: input.correlationId, startedAt, ...result });
    },
    get: deps.repository.get.bind(deps.repository),
    list: deps.repository.list.bind(deps.repository),
    async remove(input: { organizationMongoId: string; userMongoId: string; sourceId: string; correlationId: string }) {
      const requested = await deps.repository.requestDeletion({ organizationMongoId: input.organizationMongoId, sourceId: input.sourceId, actorUserMongoId: input.userMongoId, correlationId: input.correlationId, now: now() });
      await deps.storage.delete(requested.objectKey);
      return deps.repository.markDeleted({ organizationMongoId: input.organizationMongoId, sourceId: input.sourceId, actorUserMongoId: input.userMongoId, correlationId: input.correlationId });
    },
  };
};
