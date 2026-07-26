/* AUTO-GENERATED from contracts/proposal/v1. Do not edit directly. */

export interface ProposalExtractionPatchV1 {
  schemaVersion: "proposal-extraction-patch.v1";
  proposalId: string;
  proposalVersion: number;
  /**
   * @minItems 1
   */
  sourceVersionIds: [string, ...string[]];
  /**
   * @maxItems 1000
   */
  candidates: Candidate[];
}
export interface Candidate {
  path: string;
  value: unknown;
  /**
   * @minItems 1
   */
  evidence: [Evidence, ...Evidence[]];
  confidence: number;
  state: "pending" | "accepted" | "modified" | "rejected";
  conflict?: {
    kind: "source_conflict" | "ambiguous" | "stale" | "unsupported";
    description: string;
  };
  validation: {
    valid: boolean;
    issues?: string[];
  };
}
export interface Evidence {
  sourceVersionId: string;
  fragmentId: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
}
