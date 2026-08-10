import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { PDFParse } from "pdf-parse";
import { KnowledgeIngestionError } from "./domain";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as { extractRawText: (value: { buffer: Buffer }) => Promise<{ value: string }> };

export type SourceFragment = { ordinal: number; content: string; coordinates: Record<string, string | number>; checksum: string };
export type ParseResult = { parserKind: string; parserVersion: "deterministic-v1"; fragments: SourceFragment[] };

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FRAGMENTS = 5000;
const MAX_CONTENT = 50_000;

const clean = (value: string): string => value.split("\0").join("").replace(/\r\n/g, "\n").trim();
const fragment = (ordinal: number, content: string, coordinates: SourceFragment["coordinates"]): SourceFragment => {
  const value = clean(content).slice(0, MAX_CONTENT);
  return { ordinal, content: value, coordinates, checksum: crypto.createHash("sha256").update(value.normalize("NFKC")).digest("hex") };
};
const ensure = (bytes: Buffer, fragments: SourceFragment[]): SourceFragment[] => {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new KnowledgeIngestionError("PARSER_INPUT_INVALID", "Source size is invalid.", 422);
  const safe = fragments.filter((item) => item.content);
  if (!safe.length) throw new KnowledgeIngestionError("EMPTY_SOURCE", "No deterministic text could be extracted.", 422);
  if (safe.length > MAX_FRAGMENTS) throw new KnowledgeIngestionError("PARSER_LIMIT_EXCEEDED", "Source produces too many fragments.", 413);
  return safe;
};

const delimited = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
};

const pad = (value: number): string => String(value).padStart(2, "0");
const cellText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const hasTime = value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds() || value.getUTCMilliseconds();
    return hasTime ? value.toISOString() : date;
  }
  if (typeof value === "object") {
    if ("formula" in value) return `[FORMULA] ${"result" in value && value.result !== undefined ? String(value.result) : ""}`.trim();
    if ("text" in value) return String(value.text);
    if ("richText" in value) return value.richText.map((item) => item.text).join("");
    return JSON.stringify(value);
  }
  return String(value);
};

const textBlocks = (text: string): Array<{ content: string; start: number; end: number }> => {
  const normalized = clean(text);
  const raw = normalized.split(/\n{2,}/);
  const blocks: Array<{ content: string; start: number; end: number }> = [];
  let cursor = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const content = clean(raw[index]);
    const start = cursor, end = start + content.length;
    const contextualLead = /:$/.test(content)
      || (/^[A-Z0-9 &/–—-]{3,80}$/.test(content) && /[A-Z]/.test(content))
      || /^(?:[A-Za-z]+\s+)?\d{1,2},?\s+(?:\d{4},?\s+)?\d{1,2}:\d{2}/.test(content);
    const next = raw[index + 1] ? clean(raw[index + 1]) : "";
    if (contextualLead && next && content.length + next.length + 2 <= MAX_CONTENT) {
      blocks.push({ content: `${content}\n\n${next}`, start, end: end + 2 + next.length });
      cursor = end + 2 + next.length + 2;
      index += 1;
    } else {
      blocks.push({ content, start, end });
      cursor = end + 2;
    }
  }
  return blocks;
};

const headerTerms = /\b(?:event|date|start|end|time|venue|location|attendance|attendees|format|room|function|budget|deadline|due|load[- ]?in|strike|rehearsal|stream|recording|camera|requirement|value)\b/i;
const headerRowIndex = (rows: string[][]): number => {
  let bestIndex = 0, bestScore = -1;
  rows.slice(0, 20).forEach((row, index) => {
    const nonEmpty = row.filter((cell) => clean(cell));
    const score = nonEmpty.length + nonEmpty.filter((cell) => headerTerms.test(cell)).length * 3;
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  });
  return bestIndex;
};

const tableRowContent = (row: string[], headers: string[], rowIndex: number, headerIndex: number): string => row
  .map((value, columnIndex) => ({ value: clean(value), header: clean(headers[columnIndex] ?? ""), columnIndex }))
  .filter((item) => item.value)
  .map((item) => rowIndex > headerIndex && item.header && item.header !== item.value
    ? `Column ${item.columnIndex + 1} (${item.header}): ${item.value}`
    : `Column ${item.columnIndex + 1}: ${item.value}`)
  .join("\n");

const tableFragments = (rows: string[][], coordinate: (row: number, columns: number) => SourceFragment["coordinates"]): SourceFragment[] => {
  const headerIndex = headerRowIndex(rows);
  const headers = rows[headerIndex] ?? [];
  return rows.map((row, index) => fragment(index, tableRowContent(row, headers, index, headerIndex), coordinate(index + 1, row.length)));
};

// Each parser produces reviewable, checksum-bound fragments. Text headings and
// schedule labels remain attached to the immediately following value block;
// tabular rows carry their header labels so a model never sees anonymous cell
// numbers such as "1:450" without knowing what 450 represents.
export const deterministicParser = {
  async parse(bytes: Buffer, mimeType: string): Promise<ParseResult> {
    // Every approved MIME branch assigns the parser kind before returning.
    // eslint-disable-next-line no-useless-assignment
    let parserKind = "";
    let fragments: SourceFragment[] = [];
    if (mimeType === "application/pdf") {
      parserKind = "pdf-native-text";
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        fragments = result.pages.map((page, index) => fragment(index, page.text, { page: page.num }));
      } finally { await parser.destroy(); }
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      parserKind = "docx-native-text";
      const result = await mammoth.extractRawText({ buffer: bytes });
      fragments = textBlocks(result.value).map((block, index) => fragment(index, block.content, { characterStart: block.start, characterEnd: block.end }));
    } else if (mimeType === "text/csv") {
      parserKind = "csv";
      fragments = tableFragments(delimited(bytes.toString("utf8")), (row, columns) => ({ row, columnStart: 1, columnEnd: columns }));
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      parserKind = "xlsx";
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      let ordinal = 0;
      workbook.eachSheet((sheet) => {
        if (sheet.rowCount > 100_000 || sheet.columnCount > 500) throw new KnowledgeIngestionError("PARSER_LIMIT_EXCEEDED", "Spreadsheet exceeds parser limits.", 413);
        const rows: Array<{ rowNumber: number; values: string[] }> = [];
        sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          const values = Array.from({ length: row.cellCount }, (_, index) => cellText(row.getCell(index + 1).value));
          if (values.some((value) => clean(value))) rows.push({ rowNumber, values });
        });
        const headerIndex = headerRowIndex(rows.map((row) => row.values));
        const headers = rows[headerIndex]?.values ?? [];
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          fragments.push(fragment(ordinal, tableRowContent(row.values, headers, index, headerIndex), {
            sheet: sheet.name.slice(0, 100), row: row.rowNumber, columnStart: 1, columnEnd: row.values.length,
          }));
          ordinal += 1;
        }
      });
    } else if (mimeType === "text/plain") {
      parserKind = "text";
      fragments = textBlocks(bytes.toString("utf8")).map((block, index) => fragment(index, block.content, { characterStart: block.start, characterEnd: block.end }));
    } else throw new KnowledgeIngestionError("UNSUPPORTED_PARSER", "No deterministic parser is approved for this file type.", 415);
    return { parserKind, parserVersion: "deterministic-v1", fragments: ensure(bytes, fragments) };
  },
};
