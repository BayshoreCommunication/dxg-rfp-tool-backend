import type { ProviderAttemptContext } from "../liveAi/attemptLedger";
import type { ProviderFactOutput, ProviderMappingOutput } from "./domain";

export type IntelligenceEvidence = {
  id: string;
  sourceLabel: string;
  locator: Record<string, string | number>;
  content: string;
  trustClass: "untrusted_vendor_content";
};
export type IntelligenceRequirement = { id: string; title: string; text: string; kind: string; mandatory: boolean };

export interface VendorFactMappingProvider {
  extractFacts(input: { evidence: IntelligenceEvidence[]; ledger: ProviderAttemptContext; phase: string }): Promise<{ output: ProviderFactOutput; model: string }>;
  mapRequirements(input: { requirements: IntelligenceRequirement[]; evidence: IntelligenceEvidence[]; ledger: ProviderAttemptContext; phase: string }): Promise<{ output: ProviderMappingOutput; model: string }>;
}
