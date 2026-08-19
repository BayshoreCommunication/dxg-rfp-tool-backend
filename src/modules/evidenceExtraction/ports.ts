import type { SourceFragment, SourceTable } from "../knowledgeIngestion/deterministicParser";

export type OcrPageResult = {
  provider: string;
  providerVersion: string;
  fragments: SourceFragment[];
  tables: SourceTable[];
};

export interface OcrLayoutProvider {
  extractPdfPage(input: { bytes: Buffer; pageNumber: number }): Promise<OcrPageResult>;
}

