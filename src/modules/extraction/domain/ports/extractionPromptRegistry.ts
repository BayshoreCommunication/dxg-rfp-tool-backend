export type ExtractionPrompt = {
  id: "legacy-proposal-extraction.v1" | "active-proposal-extraction.v2";
  version: 1 | 2;
  content: string;
  outputSchemaId: "legacy-proposal-extraction-result.v1";
};

export interface ExtractionPromptRegistry {
  current(): ExtractionPrompt;
}

export interface ExtractionOutputValidator {
  validate(value: unknown):
    | { valid: true; data: Record<string, unknown> }
    | { valid: false; issues: string[] };
}
