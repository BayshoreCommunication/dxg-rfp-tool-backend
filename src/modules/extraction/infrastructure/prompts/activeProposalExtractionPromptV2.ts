import { LEGACY_PROPOSAL_EXTRACTION_PROMPT_V1 } from "./legacyProposalExtractionPromptV1";

/**
 * The compatibility validator still accepts the historical proposal shape,
 * but the active model prompt must not request the dormant standalone section.
 * Keep v1 intact so the old contract can be restored without reconstructing it.
 */
export const ACTIVE_PROPOSAL_EXTRACTION_PROMPT_V2 =
  LEGACY_PROPOSAL_EXTRACTION_PROMPT_V1.replace(
    /\n {2}"videoRecordingStep": \{[\s\S]*?\n {2}\},\n {2}"venue": \{/,
    '\n  "venue": {',
  );
