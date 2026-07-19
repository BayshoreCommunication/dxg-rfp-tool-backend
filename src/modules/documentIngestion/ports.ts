import type { AllowedDocumentMime, DocumentSource } from "./domain";

export type CreateSourceInput = {
  organizationMongoId: string; userMongoId: string; proposalMongoId: string;
  originalFilename: string; safeFilename: string; mimeType: AllowedDocumentMime;
  expectedSizeBytes: number; objectKey: string; retentionUntil: Date | null; idempotencyKey: string; correlationId: string;
};

export interface DocumentRepository {
  create(input: CreateSourceInput): Promise<{ source: DocumentSource; objectKey: string; created: boolean }>;
  get(organizationMongoId: string, sourceId: string): Promise<DocumentSource & { objectKey: string }>;
  complete(input: { organizationMongoId: string; sourceId: string; actualSizeBytes: number; detectedMimeType: string; sha256: string; storageVersion?: string; correlationId: string; actorUserMongoId: string }): Promise<DocumentSource>;
  beginScan(organizationMongoId: string, sourceId: string): Promise<{ source: DocumentSource; objectKey: string }>;
  finishScan(input: { organizationMongoId: string; sourceId: string; scanner: string; scannerVersion?: string; signatureVersion?: string; status: "clean" | "infected" | "error" | "unavailable"; diagnosticCode?: string; startedAt: Date; actorUserMongoId: string; correlationId: string }): Promise<DocumentSource>;
  list(organizationMongoId: string, proposalMongoId: string, limit: number): Promise<DocumentSource[]>;
  requestDeletion(input: { organizationMongoId: string; sourceId: string; actorUserMongoId: string; correlationId: string; now: Date }): Promise<{ source: DocumentSource; objectKey: string }>;
  markDeleted(input: { organizationMongoId: string; sourceId: string; actorUserMongoId: string; correlationId: string }): Promise<DocumentSource>;
}

export interface PrivateDocumentStorage {
  createUpload(input: { objectKey: string; contentType: string; sizeBytes: number; expiresSeconds: number }): Promise<{ uploadUrl: string; expiresAt: string }>;
  read(input: { objectKey: string; maxBytes: number }): Promise<{ bytes: Buffer; sizeBytes: number; versionId?: string }>;
  delete(objectKey: string): Promise<void>;
}

export type ScanResult = { status: "clean" | "infected" | "error" | "unavailable"; scanner: string; scannerVersion?: string; signatureVersion?: string; diagnosticCode?: string };
export interface MalwareScanner { scan(bytes: Buffer): Promise<ScanResult>; }
