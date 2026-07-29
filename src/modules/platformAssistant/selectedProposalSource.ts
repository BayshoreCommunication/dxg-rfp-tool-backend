import Proposal from "../../../modal/proposalsModel";
import {
  buildSelectedProposalKnowledge,
  SELECTED_PROPOSAL_KNOWLEDGE_VERSION,
} from "../conversations/selectedProposalKnowledge";
import { computeGuidance } from "../guidance/domain";
import type {
  AssistantProposalContextResolution,
  AssistantProposalContextSource,
} from "./ports";
import type {
  AssistantPromptEvidence,
  PlatformAssistantContext,
} from "./domain";

const MAX_PROPOSAL_CANDIDATES = 500;
const SAFE_PROPOSAL_FIELDS = [
  "status",
  "isDraft",
  "isActive",
  "isCopy",
  "version",
  "event",
  "venueSchedule",
  "roomByRoom",
  "production",
  "hybridVirtual",
  "contentCreative",
  "videoRecordingStep",
  "venue",
  "budget",
].join(" ");

type ProposalCandidate = Record<string, unknown> & {
  status?: unknown;
  isDraft?: unknown;
  isActive?: unknown;
  isCopy?: unknown;
  event?: { eventName?: unknown };
};

type FindOwnedProposals = (
  context: PlatformAssistantContext,
) => Promise<ProposalCandidate[]>;

const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

const proposalName = (proposal: ProposalCandidate): string => {
  const value = proposal.event?.eventName;
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
};

const matchingCandidates = (
  proposals: readonly ProposalCandidate[],
  message: string,
): ProposalCandidate[] => {
  const normalizedMessage = ` ${normalize(message)} `;
  if (normalizedMessage.trim().length < 3) return [];
  const matches = proposals.filter((proposal) => {
    const name = normalize(proposalName(proposal));
    return name.length >= 3 && normalizedMessage.includes(` ${name} `);
  });
  if (matches.length < 2) return matches;
  const longestName = Math.max(
    ...matches.map((proposal) => normalize(proposalName(proposal)).length),
  );
  const longestMatches = matches.filter(
    (proposal) => normalize(proposalName(proposal)).length === longestName,
  );
  const distinctNames = new Set(
    longestMatches.map((proposal) => normalize(proposalName(proposal))),
  );
  if (distinctNames.size !== 1) return longestMatches;

  const activeSubmittedMatches = longestMatches.filter(
    (proposal) =>
      proposal.status === "submitted" &&
      proposal.isDraft !== true &&
      proposal.isActive !== false,
  );
  return activeSubmittedMatches.length === 1
    ? activeSubmittedMatches
    : longestMatches;
};

const proposalEvidence = (
  proposal: ProposalCandidate,
): AssistantPromptEvidence[] => {
  const name = proposalName(proposal);
  const knowledge = buildSelectedProposalKnowledge(proposal);
  const base = {
    sourceType: "selected_proposal" as const,
    trust: "authorized_private_data" as const,
    href: "/proposals",
    releaseId: SELECTED_PROPOSAL_KNOWLEDGE_VERSION,
  };
  const overview: AssistantPromptEvidence = {
    ...base,
    id: "selected-proposal:overview",
    title: `${name} — overview`,
    fragmentId: "overview",
    content: JSON.stringify({
      proposalName: name,
      proposalVersion: knowledge.proposalVersion,
      lifecycle: knowledge.lifecycle,
      event: knowledge.sections.event ?? {},
      snapshotCoverage: "bounded_privacy_filtered",
    }),
  };
  const guidance = computeGuidance(proposal, {
    proposalVersion: knowledge.proposalVersion,
  });
  const privatePath = (path: string) =>
    path.startsWith("/content/contact") ||
    path.startsWith("/content/uploads");
  const readiness: AssistantPromptEvidence = {
    ...base,
    id: "selected-proposal:readiness",
    title: `${name} — readiness`,
    fragmentId: "readiness",
    content: JSON.stringify({
      proposalName: name,
      analysisVersion: guidance.analysisVersion,
      essentialMissing: guidance.completeness
        .flatMap((section) => section.essentialMissing)
        .filter((path) => !privatePath(path)),
      findings: guidance.findings
        .filter(
          (finding) =>
            !/CONTACT|UPLOAD/.test(finding.code) &&
            finding.paths.every((path) => !privatePath(path)),
        )
        .slice(0, 20)
        .map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          message: finding.message,
          paths: finding.paths,
          suggestedNextStep: finding.suggestedNextStep,
        })),
    }),
  };
  const sections = Object.entries(knowledge.sections)
    .filter(([section]) => section !== "event")
    .map<AssistantPromptEvidence>(([section, data]) => ({
      ...base,
      id: `selected-proposal:${section}`,
      title: `${name} — ${section
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLocaleLowerCase("en-US")}`,
      fragmentId: section,
      content: JSON.stringify({
        proposalName: name,
        section,
        data,
      }),
    }));
  return [overview, readiness, ...sections];
};

export const createAssistantProposalContextSource = (
  findOwnedProposals: FindOwnedProposals,
): AssistantProposalContextSource => ({
  async resolve(input): Promise<AssistantProposalContextResolution> {
    const proposals = await findOwnedProposals(input);
    const messages = [
      input.query,
      ...input.recentUserMessages.slice(-8).reverse(),
    ];

    for (const message of messages) {
      const matches = matchingCandidates(proposals, message);
      if (matches.length === 1) {
        const name = proposalName(matches[0]);
        return {
          state: "matched",
          proposalName: name,
          evidence: proposalEvidence(matches[0]),
        };
      }
      if (matches.length > 1) {
        return {
          state: "ambiguous",
          proposalNames: matches
            .map(proposalName)
            .filter(Boolean)
            .slice(0, 5),
          evidence: [],
        };
      }
    }

    return { state: "not_found", evidence: [] };
  },
});

export const mongoAssistantProposalContextSource =
  createAssistantProposalContextSource(async (context) =>
    Proposal.find({
      userId: context.actorUserMongoId,
      isArchived: { $ne: true },
      isCopy: { $ne: true },
      $or: [
        { organizationId: context.organizationMongoId },
        { organizationId: { $exists: false } },
        { organizationId: null },
      ],
    })
      .select(SAFE_PROPOSAL_FIELDS)
      .sort({ updatedAt: -1 })
      .limit(MAX_PROPOSAL_CANDIDATES)
      .lean<ProposalCandidate[]>(),
  );
