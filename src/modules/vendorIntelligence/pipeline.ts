import type { ProviderAttemptContext } from "../liveAi/attemptLedger";
import {
  assignContradictionGroups,
  contentChecksum,
  validateFacts,
  validateGroundedFacts,
  validateMappings,
  type ProviderMapping,
  type ValidatedFact,
} from "./domain";
import type { IntelligenceEvidence, IntelligenceRequirement, VendorFactMappingProvider } from "./ports";

const FACT_CHUNK = 10;
const REQUIREMENT_CHUNK = 20;
const MAX_MAPPING_EVIDENCE = 70;
const GUARANTEED_EVIDENCE_PER_REQUIREMENT = 3;
const SOURCE_BASELINE_LIMIT = 10;
const stopWords = new Set(["that", "this", "with", "from", "will", "must", "shall", "have", "into", "your", "their", "vendor", "proposal", "requirement"]);
const tokens = (value: string): string[] => [...new Set(value.toLocaleLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
  .filter((token) => !stopWords.has(token));

const chunks = <T>(items: T[], size: number): T[][] => {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
};

const groundedFacts = (facts: ValidatedFact[], evidence: IntelligenceEvidence[]) => {
  const content = new Map(evidence.map((item) => [item.id, item.content]));
  return facts.flatMap((fact) => {
    try {
      return validateGroundedFacts([fact], content);
    } catch (error) {
      if ((error as { code?: string }).code === "CITATION_GROUNDING_FAILED") return [];
      throw error;
    }
  });
};

const completeMissingMappings = (
  requirements: IntelligenceRequirement[],
  mappings: Array<{
    requirementId: string;
    relationship: "supports" | "partially_supports" | "contradicts" | "context_only" | "none";
    confidence: number;
    candidateFragmentIds: string[];
    ambiguityReasons: string[];
  }>,
) => {
  const returned = new Set(mappings.map((mapping) => mapping.requirementId));
  return [
    ...mappings,
    ...requirements.flatMap((requirement) => returned.has(requirement.id) ? [] : [{
      requirementId: requirement.id,
      relationship: "none" as const,
      confidence: 0,
      candidateFragmentIds: [],
      ambiguityReasons: ["No supported evidence mapping was returned; treated as not evidenced."],
    }]),
  ];
};

export const selectMappingEvidence = (
  requirements: IntelligenceRequirement[],
  evidence: IntelligenceEvidence[],
): IntelligenceEvidence[] => {
  const selected = new Map<string, IntelligenceEvidence>();
  const fragmentTokens = new Map(evidence.map((fragment) => [fragment.id, new Set(tokens(fragment.content))]));
  const ranked = requirements.map((requirement) => {
    const terms = tokens(`${requirement.title} ${requirement.text}`);
    return evidence.map((fragment) => ({
      fragment,
      score: terms.reduce((score, term) => score + (fragmentTokens.get(fragment.id)?.has(term) ? 1 : 0), 0),
    }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.fragment.id.localeCompare(right.fragment.id));
  });
  for (let round = 0; round < GUARANTEED_EVIDENCE_PER_REQUIREMENT; round += 1) {
    for (const candidates of ranked) {
      const item = candidates[round];
      if (item && selected.size < MAX_MAPPING_EVIDENCE) selected.set(item.fragment.id, item.fragment);
    }
  }
  const bySource = new Map<string, IntelligenceEvidence[]>();
  evidence.forEach((fragment) => bySource.set(fragment.sourceLabel, [...(bySource.get(fragment.sourceLabel) ?? []), fragment]));
  let baseline = 0;
  for (let round = 0; baseline < SOURCE_BASELINE_LIMIT && selected.size < MAX_MAPPING_EVIDENCE; round += 1) {
    let added = false;
    for (const source of [...bySource.keys()].sort()) {
      const fragment = bySource.get(source)?.[round];
      if (!fragment) continue;
      const before = selected.size;
      selected.set(fragment.id, fragment);
      if (selected.size > before) baseline += 1;
      added = true;
      if (baseline >= SOURCE_BASELINE_LIMIT || selected.size >= MAX_MAPPING_EVIDENCE) break;
    }
    if (!added) break;
  }
  for (let round = GUARANTEED_EVIDENCE_PER_REQUIREMENT; selected.size < MAX_MAPPING_EVIDENCE; round += 1) {
    let added = false;
    for (const candidates of ranked) {
      const item = candidates[round];
      if (!item) continue;
      selected.set(item.fragment.id, item.fragment); added = true;
      if (selected.size >= MAX_MAPPING_EVIDENCE) break;
    }
    if (!added) break;
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
    facts.push(...groundedFacts(
      validateFacts(result.output, new Set(evidenceChunk.map((item) => item.id))),
      evidenceChunk,
    ));
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
      { mappings: completeMissingMappings(requirementChunk, result.output.mappings) },
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
