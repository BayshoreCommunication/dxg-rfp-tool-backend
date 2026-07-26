export const allowedDocumentTypes = {
  "application/pdf": ["pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "text/csv": ["csv"],
  "text/plain": ["txt"],
} as const;

export type AllowedDocumentMime = keyof typeof allowedDocumentTypes;
export type DocumentStatus = "pending_upload" | "uploaded" | "scanning" | "ready" | "blocked" | "scan_failed" | "expired" | "deletion_pending" | "deleted";

export type DocumentSource = {
  id: string;
  proposalMongoId: string | null;
  confidentiality: "non_confidential"|"internal"|"confidential"|"restricted";
  // Surfaced so the UI can label a source the planner never explicitly added,
  // and so the scan handler knows whether to chain extraction.
  origin: "upload"|"notes"|"conversation";
  status: DocumentStatus;
  originalFilename: string;
  mimeType: string;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
  sha256: string | null;
  duplicateSourceId: string | null;
  retentionUntil: string | null;
  legalHold: boolean;
  createdAt: string;
  updatedAt: string;
};

export class DocumentIngestionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const safeFilename = (value: string) => {
  const leaf = value.split(/[\\/]/).pop()?.normalize("NFKC") ?? "document";
  const sanitized = leaf.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
  return (sanitized || "document").slice(0, 255);
};

export const validateUpload = (filename: string, mimeType: string, sizeBytes: number, maxBytes: number) => {
  const normalized = mimeType.toLowerCase() as AllowedDocumentMime;
  const extensions = allowedDocumentTypes[normalized];
  if (!extensions) throw new DocumentIngestionError("UNSUPPORTED_MEDIA_TYPE", "Supported file types are PDF, DOCX, XLSX, CSV, and TXT.", 415);
  const extension = filename.split(".").pop()?.toLowerCase();
  if (!extension || !(extensions as readonly string[]).includes(extension)) {
    throw new DocumentIngestionError("FILE_TYPE_MISMATCH", "The filename extension does not match the declared file type.", 415);
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxBytes) {
    throw new DocumentIngestionError("FILE_SIZE_INVALID", `File size must be between 1 and ${maxBytes} bytes.`, 413);
  }
  return { mimeType: normalized, filename: safeFilename(filename) };
};

export const detectMimeType = (bytes: Buffer, declared: AllowedDocumentMime): AllowedDocumentMime | null => {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return declared === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      declared === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ? declared : null;
  }
  if (declared === "text/plain" || declared === "text/csv") {
    const sample = bytes.subarray(0, 8192);
    if (!sample.includes(0)) return declared;
  }
  return null;
};
