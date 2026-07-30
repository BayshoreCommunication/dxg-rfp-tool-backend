import { documentIngestion } from "./composition";
import { DocumentIngestionError } from "./domain";

/**
 * Turn planner-supplied text into a scanned private source.
 *
 * This was inline in createProposalNotes, reachable only through the HTTP
 * handler. Conversational extraction needs the identical boundary — presigned
 * PUT into quarantine, size and content verification, then the standard scan —
 * driven from the server rather than from a request, so it lives here and both
 * callers share one implementation. Extraction structurally requires a stored,
 * scanned, parsed source; there is no in-memory shortcut.
 */
export type TextSourceOrigin = "notes" | "conversation";

export const MAX_TEXT_SOURCE_CHARS = 200_000;

export const normalizeSourceText = (value: unknown): string => {
  const text = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (!text || text.length > MAX_TEXT_SOURCE_CHARS)
    throw new DocumentIngestionError(
      "INVALID_NOTES",
      `Notes must be between 1 and ${MAX_TEXT_SOURCE_CHARS} characters.`,
      422,
    );
  // Constructed rather than written as a literal: a raw NUL byte in a source
  // file corrupts diffs and editors. These would otherwise survive into the
  // parser and the provider payload.
  if (text.includes(String.fromCharCode(0)))
    throw new DocumentIngestionError("INVALID_NOTES", "Notes contain unsupported characters.", 422);
  return text;
};

export const sourceFilename = (title: string): string =>
  `${title.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "pasted-notes"}.txt`;

export const createTextSource = async (input: {
  organizationMongoId: string;
  userMongoId: string;
  correlationId: string;
  proposalMongoId: string;
  // Unknown, not string: normalizeSourceText owns type and content validation
  // so both callers get identical rejection behaviour rather than each
  // pre-checking differently.
  text: unknown;
  title: string;
  origin: TextSourceOrigin;
  classification: string;
  idempotencyKey: string;
  segmentMessageId?: string | null;
}) => {
  const text = normalizeSourceText(input.text);
  const bytes = Buffer.from(text, "utf8");
  const session = await documentIngestion.createUpload({
    organizationMongoId: input.organizationMongoId,
    userMongoId: input.userMongoId,
    correlationId: input.correlationId,
    proposalMongoId: input.proposalMongoId,
    filename: sourceFilename(input.title),
    mimeType: "text/plain",
    sizeBytes: bytes.length,
    classification: input.classification,
    idempotencyKey: input.idempotencyKey,
    origin: input.origin,
    segmentMessageId: input.segmentMessageId ?? null,
  });
  // A replayed request returns the existing session; re-PUTting would overwrite
  // bytes a scan may already have cleared.
  if (session.created) {
    const put = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    });
    if (!put.ok)
      throw new DocumentIngestionError(
        "STORAGE_UNAVAILABLE",
        "Notes could not be stored. Please try again.",
        503,
      );
  }
  const source = await documentIngestion.complete({
    organizationMongoId: input.organizationMongoId,
    userMongoId: input.userMongoId,
    correlationId: input.correlationId,
    sourceId: session.source.id,
  });
  return { source, created: session.created };
};
