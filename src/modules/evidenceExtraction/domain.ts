import crypto from "node:crypto";
import type { SourceFragment, SourceTable } from "../knowledgeIngestion/deterministicParser";

export const EXTRACTION_POLICY_VERSION = "vendor-evidence.v1";
export const MAX_EXTRACTION_BYTES = 50 * 1024 * 1024;

export type ExtractionWarning = {
  code: string;
  message: string;
  locator?: Record<string, string | number>;
};

export type ExtractedSource = {
  status: "succeeded" | "partial" | "unreadable";
  method: "native" | "native_with_ocr" | "ocr";
  parserKind: string | null;
  parserVersion: string | null;
  ocrProvider: string | null;
  ocrProviderVersion: string | null;
  fragments: SourceFragment[];
  tables: SourceTable[];
  pageCount: number;
  coverage: number;
  warnings: ExtractionWarning[];
  outputChecksum: string | null;
};

export class EvidenceExtractionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export const checksum = (value: Buffer | string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

export const extractionOutputChecksum = (
  fragments: SourceFragment[],
  tables: SourceTable[],
): string | null => {
  if (!fragments.length && !tables.length) return null;
  return checksum([
    ...fragments.map((item) => `fragment:${item.ordinal}:${item.checksum}`),
    ...tables.map((item) => `table:${item.ordinal}:${item.checksum}`),
  ].join("\n"));
};

export const supportedEvidenceMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
]);

