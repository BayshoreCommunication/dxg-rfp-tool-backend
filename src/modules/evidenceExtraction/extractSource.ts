import { PDFDocument } from "pdf-lib";
import type { SourceFragment, SourceTable } from "../knowledgeIngestion/deterministicParser";
import { deterministicParser } from "../knowledgeIngestion/deterministicParser";
import {
  EvidenceExtractionError,
  extractionOutputChecksum,
  MAX_EXTRACTION_BYTES,
  type ExtractedSource,
  type ExtractionWarning,
} from "./domain";
import type { OcrLayoutProvider } from "./ports";

const useful = (text: string): boolean => {
  const normalized = text.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  return normalized.length >= 20 && normalized.split(/\s+/).filter(Boolean).length >= 5;
};

const normalizeOrdinals = (fragments: SourceFragment[]): SourceFragment[] =>
  fragments.map((fragment, ordinal) => ({ ...fragment, ordinal }));

const normalizeTables = (tables: SourceTable[]): SourceTable[] =>
  tables.map((table, ordinal) => ({ ...table, ordinal }));

export const extractEvidenceSource = async (input: {
  bytes: Buffer;
  mimeType: string;
  ocr: OcrLayoutProvider;
}): Promise<ExtractedSource> => {
  if (!input.bytes.length || input.bytes.length > MAX_EXTRACTION_BYTES) {
    throw new EvidenceExtractionError("SOURCE_SIZE_INVALID", "The source size is invalid.", 422);
  }
  if (input.mimeType !== "application/pdf") {
    try {
      const native = await deterministicParser.parse(input.bytes, input.mimeType);
      return {
        status: "succeeded",
        method: "native",
        parserKind: native.parserKind,
        parserVersion: native.parserVersion,
        ocrProvider: null,
        ocrProviderVersion: null,
        fragments: native.fragments,
        tables: native.tables,
        pageCount: 0,
        coverage: 1,
        warnings: [],
        outputChecksum: extractionOutputChecksum(native.fragments, native.tables),
      };
    } catch (error) {
      const code = String((error as { code?: string }).code ?? "NATIVE_EXTRACTION_FAILED");
      throw new EvidenceExtractionError(code, "The source could not be read.", code === "UNSUPPORTED_PARSER" ? 415 : 422);
    }
  }

  let pageCount: number;
  try {
    pageCount = (await PDFDocument.load(input.bytes, { ignoreEncryption: true })).getPageCount();
  } catch {
    throw new EvidenceExtractionError("PDF_INVALID", "The PDF could not be opened.", 422);
  }
  let nativeFragments: SourceFragment[] = [];
  let parserKind: string | null = null;
  let parserVersion: string | null = null;
  try {
    const native = await deterministicParser.parse(input.bytes, input.mimeType);
    nativeFragments = native.fragments;
    parserKind = native.parserKind;
    parserVersion = native.parserVersion;
  } catch {
    // An image-only PDF is expected to fail native parsing; OCR handles it below.
  }
  const nativeByPage = new Map(nativeFragments.map((fragment) => [Number(fragment.coordinates.page), fragment]));
  const missingPages = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((page) => !useful(nativeByPage.get(page)?.content ?? ""));
  const ocrFragments: SourceFragment[] = [];
  const ocrTables: SourceTable[] = [];
  const warnings: ExtractionWarning[] = [];
  let ocrProvider: string | null = null, ocrProviderVersion: string | null = null, ocrPages = 0;
  for (const pageNumber of missingPages) {
    try {
      const page = await input.ocr.extractPdfPage({ bytes: input.bytes, pageNumber });
      ocrProvider = page.provider;
      ocrProviderVersion = page.providerVersion;
      if (useful(page.fragments.map((fragment) => fragment.content).join(" "))) ocrPages += 1;
      ocrFragments.push(...page.fragments);
      ocrTables.push(...page.tables);
    } catch (error) {
      warnings.push({
        code: String((error as { code?: string }).code ?? "OCR_PAGE_FAILED"),
        message: "A page could not be extracted with OCR.",
        locator: { page: pageNumber },
      });
    }
  }
  const nativeUseful = nativeFragments.filter((fragment) => useful(fragment.content));
  const nativePages = new Set(nativeUseful.map((fragment) => Number(fragment.coordinates.page))).size;
  const fragments = normalizeOrdinals([...nativeUseful, ...ocrFragments].sort((a, b) => Number(a.coordinates.page ?? 0) - Number(b.coordinates.page ?? 0)));
  const tables = normalizeTables(ocrTables);
  const coveredPages = Math.min(pageCount, nativePages + ocrPages);
  const coverage = pageCount ? coveredPages / pageCount : 0;
  const status = coverage === 1 && fragments.length ? "succeeded" : fragments.length ? "partial" : "unreadable";
  if (coverage < 1) warnings.push({ code: "PAGE_COVERAGE_INCOMPLETE", message: "Some PDF pages produced no readable text." });
  return {
    status,
    method: missingPages.length ? (nativeUseful.length ? "native_with_ocr" : "ocr") : "native",
    parserKind,
    parserVersion,
    ocrProvider,
    ocrProviderVersion,
    fragments,
    tables,
    pageCount,
    coverage,
    warnings,
    outputChecksum: extractionOutputChecksum(fragments, tables),
  };
};
