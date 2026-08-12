import type { ProviderAttemptContext } from "../liveAi/attemptLedger";
import {
  assignContradictionGroups,
  contentChecksum,
  validateFacts,
  validateMappings,
  type ProviderMapping,
  type ValidatedFact,
} from "./domain";
import type { IntelligenceEvidence, IntelligenceRequirement, VendorFactMappingProvider } from "./ports";

const FACT_CHUNK = 35;
const REQUIREMENT_CHUNK = 20;
const MAX_MAPPING_EVIDENCE = 70;
const stopWords = new Set(["that", "this", "with", "from", "will", "must", "shall", "have", "into", "your", "their", "vendor", "proposal", "requirement"]);
const tokens = (value: string): string[] => [...new Set(value.toLocaleLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
  .filter((token) => !stopWords.has(token));

const chunks = <T>(items: T[], size: number): T[][] => {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
};

export const selectMappingEvidence = (
  requirements: IntelligenceRequirement[],
  evidence: IntelligenceEvidence[],
): IntelligenceEvidence[] => {
  const selected = new Map<string, IntelligenceEvidence>();
  for (const requirement of requirements) {
    const terms = tokens(`${requirement.title} ${requirement.text}`);
    evidence.map((fragment) => ({
      fragment,
      score: terms.reduce((score, term) => score + (fragment.content.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
    }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.fragment.id.localeCompare(right.fragment.id))
      .slice(0, 5)
      .forEach((item) => selected.set(item.fragment.id, item.fragment));
  }
  if (!selected.size) evidence.slice(0, 20).forEach((fragment) => selected.set(fragment.id, fragment));
  return [...selected.values()].slice(0, MAX_MAPPING_EVIDENCE);
};

export const runVendorFactMappingPipeline = async (input: {
  requirements: IntelligenceRequirement[];
  evidence: IntelligenceEvidence[];
  provider: VendorFactMappingProvider;
  ledger: ProviderAttemptContext;
}) => {
  const facts: ValidatedFact[] = [];
  let model = "";
  for (const [index, evidenceChunk] of chunks(input.evidence, FACT_CHUNK).entries()) {
    const result = await input.provider.extractFacts({
      evidence: evidenceChunk,
      ledger: input.ledger,
      phase: `facts:${index + 1}`,
    });
    model = result.model;
    facts.push(...validateFacts(result.output, new Set(evidenceChunk.map((item) => item.id))));
  }
  const uniqueFacts = new Map<string, ValidatedFact>();
  facts.forEach((fact) => uniqueFacts.set(contentChecksum({
    key: fact.factKey,
    value: fact.normalizedValue,
    citations: fact.citations.map((item) => [item.fragmentId, item.role]).sort(),
  }), fact));
  const mappings: ProviderMapping[] = [];
  for (const [index, requirementChunk] of chunks(input.requirements, REQUIREMENT_CHUNK).entries()) {
    const selectedEvidence = selectMappingEvidence(requirementChunk, input.evidence);
    const result = await input.provider.mapRequirements({
      requirements: requirementChunk,
      evidence: selectedEvidence,
      ledger: input.ledger,
      phase: `mappings:${index + 1}`,
    });
    model = result.model;
    mappings.push(...validateMappings(
      result.output,
      new Set(requirementChunk.map((item) => item.id)),
      new Set(selectedEvidence.map((item) => item.id)),
    ));
  }
  const contradictionFacts = assignContradictionGroups([...uniqueFacts.values()]);
  return {
    model,
    facts: contradictionFacts,
    mappings,
    outputChecksum: contentChecksum({ facts: contradictionFacts, mappings }),
  };
};
