import Proposal from "../../../modal/proposalsModel";
import { listOwnedProposals } from "../proposals/composition";
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
const PROPOSAL_PORTFOLIO_VERSION = "assistant-proposal-portfolio.v1";
const SAFE_PROPOSAL_FIELDS = [
  "status",
  "isDraft",
  "isActive",
  "isArchived",
  "isCopy",
  "isFavorite",
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
  isArchived?: unknown;
  isCopy?: unknown;
  isFavorite?: unknown;
  event?: { eventName?: unknown };
};

type ProposalPortfolioCounts = {
  totalCreated: number;
  all: number;
  draft: number;
  live: number;
  favorite: number;
  expired: number;
  archive: number;
  saved: number;
};

type FindOwnedProposals = (
  context: PlatformAssistantContext,
) => Promise<ProposalCandidate[]>;

type CountOwnedProposals = (
  context: PlatformAssistantContext,
) => Promise<ProposalPortfolioCounts>;

type ProposalContextDependencies = {
  findOwnedProposals: FindOwnedProposals;
  countOwnedProposals?: CountOwnedProposals;
};

const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

const proposalCountQuestion = (value: string): boolean => {
  const normalized = normalize(value)
    .replace(/\bmanny\b/gu, "many")
    .replace(/\bpropos(?:el|le)s?\b/gu, (match) =>
      match.endsWith("s") ? "proposals" : "proposal",
    );
  return (
    /\b(?:how many|number of|count of|total(?: number of)?)\b.{0,48}\bproposals?\b/u.test(
      normalized,
    ) ||
    /\bproposals?\b.{0,48}\b(?:count|total|how many)\b/u.test(normalized) ||
    /\bproposal count\b/u.test(normalized)
  );
};

const proposalCountFormattingFollowUp = (value: string): boolean =>
  /^(?:and |also |then |now )?(?:make (?:that|it)|shorten|shorter|summari[sz]e|concise|one short sentence)\b/i.test(
    normalize(value),
  );

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

  const mostSpecificMatches = matches.filter((candidate) => {
    const candidateName = normalize(proposalName(candidate));
    return !matches.some((other) => {
      const otherName = normalize(proposalName(other));
      return otherName !== candidateName && otherName.includes(candidateName);
    });
  });
  const distinctSpecificNames = new Set(
    mostSpecificMatches.map((proposal) => normalize(proposalName(proposal))),
  );
  if (distinctSpecificNames.size > 1) return mostSpecificMatches;

  const longestName = Math.max(
    ...mostSpecificMatches.map(
      (proposal) => normalize(proposalName(proposal)).length,
    ),
  );
  const longestMatches = mostSpecificMatches.filter(
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

const countsFromCandidates = (
  proposals: readonly ProposalCandidate[],
): ProposalPortfolioCounts => {
  const available = proposals.filter(
    (proposal) =>
      proposal.isArchived !== true && proposal.isCopy !== true,
  );
  return {
    totalCreated: proposals.length,
    all: available.length,
    draft: available.filter((proposal) => proposal.isDraft === true).length,
    live: available.filter(
      (proposal) =>
        proposal.isDraft !== true &&
        proposal.status === "submitted" &&
        proposal.isActive !== false,
    ).length,
    favorite: available.filter(
      (proposal) => proposal.isFavorite === true,
    ).length,
    expired: available.filter(
      (proposal) =>
        proposal.isDraft !== true && proposal.isActive === false,
    ).length,
    archive: proposals.filter(
      (proposal) => proposal.isArchived === true,
    ).length,
    saved: proposals.filter(
      (proposal) =>
        proposal.isArchived !== true && proposal.isCopy === true,
    ).length,
  };
};

const portfolioEvidence = (
  counts: ProposalPortfolioCounts,
): AssistantPromptEvidence => ({
  id: "proposal-portfolio:counts",
  sourceType: "proposal_portfolio",
  trust: "authorized_private_data",
  title: "Your proposal counts",
  content: JSON.stringify({
    schemaVersion: PROPOSAL_PORTFOLIO_VERSION,
    scope: "authenticated_owner_and_organization",
    totalCreated: counts.totalCreated,
    mainList: counts.all,
    draft: counts.draft,
    live: counts.live,
    favorite: counts.favorite,
    expired: counts.expired,
    archived: counts.archive,
    savedCopies: counts.saved,
  }),
  href: "/proposals",
  releaseId: PROPOSAL_PORTFOLIO_VERSION,
  fragmentId: "counts",
});

export const createAssistantProposalContextSource = (
  input: FindOwnedProposals | ProposalContextDependencies,
): AssistantProposalContextSource => {
  const dependencies: ProposalContextDependencies =
    typeof input === "function"
      ? { findOwnedProposals: input }
      : input;
  return {
    async resolve(input): Promise<AssistantProposalContextResolution> {
      const countQuestion = proposalCountQuestion(input.query)
        ? input.query
        : proposalCountFormattingFollowUp(input.query) &&
            proposalCountQuestion(input.recentUserMessages.at(-1) ?? "")
          ? input.recentUserMessages.at(-1)
          : undefined;
      if (countQuestion) {
        const counts = dependencies.countOwnedProposals
          ? await dependencies.countOwnedProposals(input)
          : countsFromCandidates(
              await dependencies.findOwnedProposals(input),
            );
        return {
          state: "portfolio_summary",
          evidence: [portfolioEvidence(counts)],
        };
      }

      const proposals = await dependencies.findOwnedProposals(input);
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
  };
};

export const mongoAssistantProposalContextSource =
  createAssistantProposalContextSource({
    findOwnedProposals: async (context) =>
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
    countOwnedProposals: async (context) => {
      const [totalCreated, list] = await Promise.all([
        Proposal.countDocuments({
          userId: context.actorUserMongoId,
          organizationId: context.organizationMongoId,
        }),
        listOwnedProposals({
          ownerUserId: context.actorUserMongoId,
          query: {
            includeCounts: "true",
            page: "1",
            limit: "1",
          },
        }),
      ]);
      const counts = list.counts ?? {
        all: 0,
        draft: 0,
        live: 0,
        favorite: 0,
        expired: 0,
        archive: 0,
        saved: 0,
      };
      return { totalCreated, ...counts };
    },
  });
