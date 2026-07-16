import { createExtractProposalDocument } from "./application/extractProposalDocument";
import { legacyOpenAiProposalExtractionModel } from "./infrastructure/openai/legacyOpenAiProposalExtractionModel";
import { legacyDocumentTextExtractor } from "./infrastructure/parsers/legacyDocumentTextExtractor";
import { versionedExtractionPromptRegistry } from "./infrastructure/prompts/versionedExtractionPromptRegistry";
import { ajvLegacyExtractionOutputValidator } from "./infrastructure/validation/ajvLegacyExtractionOutputValidator";

export const extractProposalDocument = createExtractProposalDocument({
  textExtractor: legacyDocumentTextExtractor,
  model: legacyOpenAiProposalExtractionModel,
  prompts: versionedExtractionPromptRegistry,
  outputValidator: ajvLegacyExtractionOutputValidator,
});
