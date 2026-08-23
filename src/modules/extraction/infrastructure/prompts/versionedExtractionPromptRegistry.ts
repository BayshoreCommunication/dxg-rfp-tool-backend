import type { ExtractionPromptRegistry } from "../../domain/ports/extractionPromptRegistry";
import { proposalWorkflowSectionEnabled } from "../../../proposals/domain/workflowSections";
import { ACTIVE_PROPOSAL_EXTRACTION_PROMPT_V2 } from "./activeProposalExtractionPromptV2";
import { LEGACY_PROPOSAL_EXTRACTION_PROMPT_V1 } from "./legacyProposalExtractionPromptV1";

export const versionedExtractionPromptRegistry: ExtractionPromptRegistry = {
  current() {
    if (proposalWorkflowSectionEnabled("video_recording")) {
      return {
        id: "legacy-proposal-extraction.v1",
        version: 1,
        content: LEGACY_PROPOSAL_EXTRACTION_PROMPT_V1,
        outputSchemaId: "legacy-proposal-extraction-result.v1",
      };
    }
    return {
      id: "active-proposal-extraction.v2",
      version: 2,
      content: ACTIVE_PROPOSAL_EXTRACTION_PROMPT_V2,
      outputSchemaId: "legacy-proposal-extraction-result.v1",
    };
  },
};
