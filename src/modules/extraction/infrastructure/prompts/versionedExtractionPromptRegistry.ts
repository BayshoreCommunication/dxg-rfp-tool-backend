import type { ExtractionPromptRegistry } from "../../domain/ports/extractionPromptRegistry";
import { LEGACY_PROPOSAL_EXTRACTION_PROMPT_V1 } from "./legacyProposalExtractionPromptV1";

export const versionedExtractionPromptRegistry: ExtractionPromptRegistry = {
  current() {
    return {
      id: "legacy-proposal-extraction.v1",
      version: 1,
      content: LEGACY_PROPOSAL_EXTRACTION_PROMPT_V1,
      outputSchemaId: "legacy-proposal-extraction-result.v1",
    };
  },
};
