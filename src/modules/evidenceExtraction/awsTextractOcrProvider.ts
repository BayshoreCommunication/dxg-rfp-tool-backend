import crypto from "node:crypto";
import {
  AnalyzeDocumentCommand,
  TextractClient,
  type Block,
} from "@aws-sdk/client-textract";
import { PDFDocument } from "pdf-lib";
import type { SourceFragment, SourceTable, SourceTableCell } from "../knowledgeIngestion/deterministicParser";
import { EvidenceExtractionError } from "./domain";
import type { OcrLayoutProvider, OcrPageResult } from "./ports";

const MAX_SYNC_PAGE_BYTES = 10 * 1024 * 1024;
const normalize = (value: string): string => value.replace(/\0/g, "").replace(/\s+/g, " ").trim();
const textChecksum = (value: string): string => crypto.createHash("sha256").update(value.normalize("NFKC")).digest("hex");
const bbox = (block: Block): Record<string, number> => {
  const box = block.Geometry?.BoundingBox;
  return box ? {
    left: Number(box.Left ?? 0),
    top: Number(box.Top ?? 0),
    width: Number(box.Width ?? 0),
    height: Number(box.Height ?? 0),
  } : {};
};

const blockText = (block: Block, byId: Map<string, Block>): string => normalize(
  (block.Relationships ?? [])
    .filter((relationship) => relationship.Type === "CHILD")
    .flatMap((relationship) => relationship.Ids ?? [])
    .map((id) => byId.get(id))
    .filter((child): child is Block => Boolean(child))
    .map((child) => child.BlockType === "SELECTION_ELEMENT"
      ? (child.SelectionStatus === "SELECTED" ? "[x]" : "[ ]")
      : String(child.Text ?? ""))
    .join(" "),
);

const asResult = (blocks: Block[], pageNumber: number): OcrPageResult => {
  const byId = new Map(blocks.filter((block) => block.Id).map((block) => [String(block.Id), block]));
  const lines = blocks.filter((block) => block.BlockType === "LINE" && normalize(String(block.Text ?? "")));
  const fragments: SourceFragment[] = lines.map((block, ordinal) => {
    const content = normalize(String(block.Text));
    return {
      ordinal,
      content,
      coordinates: { page: pageNumber, ...bbox(block), confidence: Number(block.Confidence ?? 0) },
      checksum: textChecksum(content),
    };
  });
  const tables: SourceTable[] = [];
  for (const tableBlock of blocks.filter((block) => block.BlockType === "TABLE")) {
    const possibleCells = (tableBlock.Relationships ?? [])
      .filter((relationship) => relationship.Type === "CHILD")
      .flatMap((relationship) => relationship.Ids ?? [])
      .map((id) => byId.get(id));
    const cellBlocks = possibleCells.filter((block): block is Block => block?.BlockType === "CELL");
    const cells: SourceTableCell[] = cellBlocks.map((block) => {
      const content = blockText(block, byId).slice(0, 50_000);
      const row = Number(block.RowIndex ?? 1), column = Number(block.ColumnIndex ?? 1);
      return {
        row,
        column,
        content,
        isHeader: (block.EntityTypes ?? []).includes("COLUMN_HEADER") || row === 1,
        coordinates: { page: pageNumber, row, column, ...bbox(block) },
        checksum: textChecksum(content),
      };
    });
    const ordinal = tables.length;
    tables.push({
      key: `page:${pageNumber}:table:${ordinal + 1}`,
      label: `Page ${pageNumber}, table ${ordinal + 1}`,
      ordinal,
      rowCount: Math.max(0, ...cells.map((cell) => cell.row)),
      columnCount: Math.max(0, ...cells.map((cell) => cell.column)),
      coordinates: { page: pageNumber, ...bbox(tableBlock) },
      checksum: textChecksum(cells.map((cell) => `${cell.row}:${cell.column}:${cell.checksum}`).join("\n")),
      cells,
    });
  }
  return { provider: "aws-textract", providerVersion: "AnalyzeDocument-2018-06-27", fragments, tables };
};

const safeProviderError = (error: unknown): EvidenceExtractionError => {
  const name = String((error as { name?: string }).name ?? "");
  const retryable = ["ThrottlingException", "ProvisionedThroughputExceededException", "InternalServerError", "TimeoutError"].includes(name);
  const code = retryable ? "OCR_PROVIDER_TEMPORARY" : name === "AccessDeniedException" || name === "UnrecognizedClientException"
    ? "OCR_PROVIDER_AUTHORIZATION"
    : "OCR_PROVIDER_UNAVAILABLE";
  return new EvidenceExtractionError(code, "OCR could not process this page.", 503, retryable);
};

export const createAwsTextractOcrProvider = (
  client = new TextractClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
    maxAttempts: 3,
  }),
): OcrLayoutProvider => ({
  async extractPdfPage({ bytes, pageNumber }): Promise<OcrPageResult> {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    if (pageNumber < 1 || pageNumber > source.getPageCount()) {
      throw new EvidenceExtractionError("OCR_PAGE_INVALID", "OCR page was outside the document.", 422);
    }
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(source, [pageNumber - 1]);
    single.addPage(page);
    const pageBytes = Buffer.from(await single.save({ useObjectStreams: true }));
    if (pageBytes.length > MAX_SYNC_PAGE_BYTES) {
      throw new EvidenceExtractionError("OCR_PAGE_TOO_LARGE", "A PDF page exceeds the OCR service limit.", 422);
    }
    try {
      const response = await client.send(new AnalyzeDocumentCommand({
        Document: { Bytes: pageBytes },
        FeatureTypes: ["TABLES", "LAYOUT"],
      }));
      return asResult(response.Blocks ?? [], pageNumber);
    } catch (error) {
      if (error instanceof EvidenceExtractionError) throw error;
      throw safeProviderError(error);
    }
  },
});

export const awsTextractOcrProvider = createAwsTextractOcrProvider();
