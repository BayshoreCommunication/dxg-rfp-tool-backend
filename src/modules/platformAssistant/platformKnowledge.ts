import type { AssistantPromptEvidence } from "./domain";

export const PLATFORM_KNOWLEDGE_VERSION = "rfpilot-platform-map.v1";

type PlatformFact = Omit<AssistantPromptEvidence, "sourceType" | "trust" | "releaseId"> & {
  keywords: readonly string[];
};

export const PLATFORM_FACTS: readonly PlatformFact[] = Object.freeze([
  {
    id: "platform:assistant:scope",
    title: "AI Assistant scope",
    content:
      "The platform AI Assistant explains RFPilot navigation, proposal workflows, event-planning concepts, and onboarding. It is read-only: it cannot edit, publish, delete, or send proposals, emails, settings, or vendor responses.",
    keywords: ["assistant", "help", "can you", "publish", "delete", "send for me", "edit for me"],
  },
  {
    id: "platform:assistant:proposal-workspace",
    title: "General assistant and proposal assistant",
    content:
      "The platform AI Assistant provides general guidance and does not automatically read a specific proposal. Work on a specific proposal belongs in that proposal's dedicated assistant at /proposals/{proposalId}/assistant.",
    href: "/proposals",
    keywords: ["proposal assistant", "specific proposal", "my proposal", "this proposal", "difference"],
  },
  {
    id: "platform:navigation:dashboard",
    title: "Dashboard",
    content:
      "The Dashboard is the signed-in landing area for a high-level view of platform activity.",
    href: "/dashboard",
    keywords: ["dashboard", "home", "overview", "activity"],
  },
  {
    id: "platform:navigation:proposals",
    title: "Proposals",
    content:
      "The Proposals page lists the signed-in user's proposals and provides entry points to create, inspect, edit, and send them.",
    href: "/proposals",
    keywords: ["proposal", "proposals", "list", "find", "edit", "create", "send"],
  },
  {
    id: "platform:navigation:create-proposal",
    title: "Create a proposal",
    content:
      "Start a new proposal at /proposals/add-new-proposal. Depending on the enabled proposal-assistant rollout, this opens either the chat-first proposal workspace or the existing guided proposal form.",
    href: "/proposals/add-new-proposal",
    keywords: ["create proposal", "new proposal", "start proposal", "add proposal"],
  },
  {
    id: "platform:proposal:workflow",
    title: "Assisted proposal workflow",
    content:
      "The assisted proposal workflow has five steps: Provide Information, Review the Draft, Answer Key Questions, See Guidance, and Publish. Final publication remains an explicit user action in the detailed proposal editor.",
    href: "/proposals",
    keywords: ["workflow", "steps", "review", "draft", "question", "guidance", "publish"],
  },
  {
    id: "platform:navigation:email",
    title: "Email",
    content:
      "The Email area shows proposal email activity. A proposal can be prepared for sending from its proposal actions, which open the send-email workflow.",
    href: "/email",
    keywords: ["email", "send proposal", "campaign", "recipient", "open rate"],
  },
  {
    id: "platform:navigation:vendor-responses",
    title: "Vendor responses",
    content:
      "The Vendor Responses page lists responses available to the signed-in user, including unread filtering and pagination.",
    href: "/vendor-responses",
    keywords: ["vendor", "response", "responses", "unread", "submission"],
  },
  {
    id: "platform:navigation:settings",
    title: "Settings",
    content:
      "The Settings page is where the signed-in user manages supported profile and branding settings.",
    href: "/settings",
    keywords: ["settings", "profile", "branding", "logo", "account"],
  },
]);

const normalizedTerms = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1);

export const platformFactsForQuery = (
  query: string,
  limit = 8,
): AssistantPromptEvidence[] => {
  const normalized = query.toLowerCase();
  const terms = new Set(normalizedTerms(query));
  const scored = PLATFORM_FACTS.map((fact, index) => {
    const score = fact.keywords.reduce((total, keyword) => {
      const phrase = keyword.toLowerCase();
      if (normalized.includes(phrase)) return total + 4;
      return total + normalizedTerms(phrase).filter((term) => terms.has(term)).length;
    }, 0);
    return { fact, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = scored.filter((item) => item.score > 0).slice(0, Math.max(1, limit));
  const fallback = PLATFORM_FACTS.filter((fact) =>
    ["platform:assistant:scope", "platform:assistant:proposal-workspace"].includes(fact.id),
  );
  const facts = selected.length ? selected.map((item) => item.fact) : fallback;

  return facts.map(({ keywords: _keywords, ...fact }) => ({
    ...fact,
    sourceType: "platform_fact",
    trust: "trusted_platform_fact",
    releaseId: PLATFORM_KNOWLEDGE_VERSION,
  }));
};
