import type { AssistantMessage, AssistantPromptEvidence } from "./domain";
import {
  proposalFormGuidanceEvidenceForField,
  proposalFormGuidanceEvidenceForQuery,
} from "./proposalFormGuidance";
import type { AssistantUiContext } from "./domain";

export const PLATFORM_KNOWLEDGE_VERSION = "rfpilot-platform-map.v4";

type PlatformFact = Omit<AssistantPromptEvidence, "sourceType" | "trust" | "releaseId"> & {
  keywords: readonly string[];
};

const ASSISTANT_CONVERSATION_FACT_QUERY_MESSAGES = 30;
const ASSISTANT_FOLLOW_UP_FACT_QUERY_MESSAGES = 1;
const ASSISTANT_CONTEXT_CHAIN_FACT_QUERY_MESSAGES = 6;

const requestsWholeConversationContext = (query: string): boolean =>
  /\b(?:summari[sz]e|recap)\b.*\b(?:everything|conversation|discussion|discussed|chat)\b/i.test(
    query,
  ) ||
  /\b(?:links?|pages?|routes?)\b.*\b(?:mentioned|discussed|covered|shared)\b/i.test(
    query,
  ) ||
  /\b(?:mentioned|discussed|covered|shared)\b.*\b(?:links?|pages?|routes?)\b/i.test(
    query,
  );

const requestsContextChain = (query: string): boolean =>
  /\b(?:that|those|these|it|them|previous|earlier|above)\b|\bthe\s+(?:answer|checklist|workflow|list|steps?|details?|priorities|plan)\b|\b(?:shorten|shorter|concise|brief|reformat|bullets?)\b/i.test(
    query,
  );

const hasStandalonePlatformTopic = (query: string): boolean =>
  /\b(?:proposal|event|venue|attendee|room|hybrid|virtual|recording|budget|vendor|settings?|email|dashboard|branding|timeline|schedule|av|production)\b/i.test(
    query,
  );

export const PLATFORM_FACTS: readonly PlatformFact[] = Object.freeze([
  {
    id: "platform:assistant:scope",
    title: "AI Assistant scope",
    content:
      "The platform AI Assistant explains RFPilot navigation, proposal workflows, form fields, event-planning concepts, and onboarding. It is read-only: it cannot edit, publish, delete, send, book, reserve, schedule, or contact people on the user's behalf. When a user requests one of those actions, it should explain the boundary and guide the user through the relevant user-operated workflow.",
    keywords: [
      "assistant",
      "help",
      "can you",
      "publish",
      "delete",
      "send for me",
      "edit for me",
      "book",
      "reserve",
      "schedule for me",
    ],
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
    id: "platform:event:planning-brief",
    title: "Event planning brief",
    content:
      "Before planning an event, gather the event purpose, dates and timings, venue or city, expected attendee count, audience type, room and session schedule, speaker or presenter needs, registration flow, audio, video, lighting, staging, internet or streaming, recording, accessibility, catering, staffing, security, transport, budget range, decision owners, and approval deadlines. Exact quantities such as speaker count, staffing, or equipment depend on the agenda, venue, service level, and production scope.",
    href: "/proposals/add-new-proposal",
    keywords: [
      "event",
      "event planning",
      "planning",
      "checklist",
      "gather",
      "attendee",
      "attendees",
      "venue",
      "speaker",
      "speakers",
      "production",
      "av",
      "ইভেন্ট",
      "পরিকল্পনা",
      "তথ্য",
      "অতিথি",
      "ভেন্যু",
      "স্পিকার",
    ],
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
      "The Proposals page lists the signed-in user's proposals and provides entry points to create, inspect, edit, delete, and send them. Deletion remains an explicit user action from the proposal's trash/delete control and may require confirmation.",
    href: "/proposals",
    keywords: ["proposal", "proposals", "list", "find", "edit", "create", "send"],
  },
  {
    id: "platform:navigation:create-proposal",
    title: "Create a proposal",
    content:
      "Open Proposals, choose New Proposal, and continue at /proposals/add-new-proposal. Use this guided intake route to record general event and proposal details before generating an RFP. Depending on the enabled rollout, the route opens either the chat-first proposal workspace or the guided intake form. The guided form can optionally pre-fill fields from an uploaded PDF, DOC, DOCX, or CSV; users can also continue without an upload.",
    href: "/proposals/add-new-proposal",
    keywords: [
      "create proposal",
      "new proposal",
      "start proposal",
      "add proposal",
      "upload proposal",
      "navigation steps",
      "record details",
      "enter details",
      "these details",
      "where should i record",
    ],
  },
  {
    id: "platform:proposal:guided-intake",
    title: "Guided proposal intake",
    content:
      "The guided proposal intake has ten sections. Its displayed badges are: 1 Event Overview; 2 Venue & Schedule; 2B Room Specifications; 3 Hybrid & Virtual (conditional and hidden for in-person-only events); 4 Content & Creative; 5 Video Recording; 6 Venue & Technical; 7 Investment & Evaluation; 8 Uploads & Co-Vendors; and 9 Contact & Submit. Users move through the form and explicitly save a draft or generate/update the RFP at the end.",
    href: "/proposals/add-new-proposal",
    keywords: [
      "proposal steps",
      "proposal form",
      "intake form",
      "input field",
      "fields",
      "event overview",
      "contact submit",
      "room specifications",
      "record details",
      "enter details",
      "these details",
    ],
  },
  {
    id: "platform:proposal:event-fields",
    title: "Event Overview fields",
    content:
      "Event Overview collects the event name, edition/year, type, theme or tagline, website, delivery format, audience types, start and end dates, total in-person attendance, objectives, tone or brand direction, sacred constraints, organization background, statement of work, event profile, and RFP timeline. Required fields are marked in the form. More specific objectives and constraints improve the generated narrative and vendor brief.",
    href: "/proposals/add-new-proposal",
    keywords: [
      "event overview",
      "event name",
      "event type",
      "event format",
      "attendees",
      "objectives",
      "input field",
      "fields",
    ],
  },
  {
    id: "platform:proposal:venue-room-fields",
    title: "Venue, schedule, and room fields",
    content:
      "Venue & Schedule collects venue name/address/city/state, union status and jurisdiction, load-in, rehearsal and strike dates/times, room count, and time zone. Room Specifications records room-by-room schedule and AV/production needs such as microphones, screens or LED walls, playback, cameras, stage lighting, confidence monitors, teleprompter, Q&A method, scenic design, union labor, and crew roles.",
    href: "/proposals/add-new-proposal",
    keywords: [
      "venue schedule",
      "room specifications",
      "room fields",
      "av requirements",
      "production crew",
      "microphone",
      "led wall",
      "input field",
    ],
  },
  {
    id: "platform:proposal:hybrid-media-fields",
    title: "Hybrid, creative, and recording fields",
    content:
      "Hybrid & Virtual collects virtual attendance, streaming platform and AV integration, stream ownership, remote speakers, rehearsal owner, virtual Q&A/breakouts, virtual producer, captions, on-demand recording, sponsor overlays, and networking. Content & Creative assigns ownership for templates, slides, graphics, recap and social content. Video Recording covers cameras, IMAG, ISO/program recordings, operators, resolution, edited deliverables, turnaround, raw footage, format, and delivery.",
    href: "/proposals/add-new-proposal",
    keywords: [
      "hybrid virtual",
      "streaming",
      "remote speakers",
      "content creative",
      "video recording",
      "camera",
      "captions",
      "input field",
    ],
  },
  {
    id: "platform:proposal:final-fields",
    title: "Technical, investment, uploads, and contact fields",
    content:
      "Venue & Technical collects the venue AV contact, in-house AV company, rigging, power, internet, insurance/COI, and access requirements. Investment & Evaluation collects the AV budget tier, proposal format, proposal/decision timeline, evaluation weights, and bid preferences. Uploads & Co-Vendors records reference files and partner details. Contact & Submit collects requester/contact details, then lets the user save a draft or explicitly generate/update the RFP.",
    href: "/proposals/add-new-proposal",
    keywords: [
      "venue technical",
      "investment evaluation",
      "budget",
      "uploads",
      "co-vendors",
      "contact submit",
      "generate rfp",
      "input field",
    ],
  },
  {
    id: "platform:proposal:workflow",
    title: "Optional assisted proposal workflow",
    content:
      "When the optional proposal-assistant workflow is enabled, it has five phases: Provide Information, Review the Draft, Answer Key Questions, See Guidance, and Publish. This is separate from the guided ten-section intake form. Final publication remains an explicit user action in the detailed proposal editor.",
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
    id: "platform:proposal:pre-send-checklist",
    title: "Proposal pre-send checklist",
    content:
      "Before sending, confirm event identity, format, dates, attendance, venue and schedule; room-by-room AV and production scope; hybrid, creative, recording, technical, insurance, and access needs where applicable; budget, evaluation weights, proposal and decision deadlines; reference uploads and co-vendor responsibilities; and accurate contact/recipient details. Review the generated RFP for gaps or blocking guidance, save or update it, then use the proposal's send-email action.",
    href: "/proposals",
    keywords: [
      "before sending",
      "before send",
      "send proposal",
      "pre-send",
      "check proposal",
      "proposal checklist",
      "client",
    ],
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
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1);

const platformFactEvidence = (
  fact: PlatformFact,
): AssistantPromptEvidence => ({
  id: fact.id,
  title: fact.title,
  content: fact.content,
  ...(fact.href ? { href: fact.href } : {}),
  sourceType: "platform_fact",
  trust: "trusted_platform_fact",
  releaseId: PLATFORM_KNOWLEDGE_VERSION,
});

export const platformFactEvidenceForHref = (
  href: string,
): AssistantPromptEvidence | undefined => {
  const fact =
    PLATFORM_FACTS.find(
      (item) =>
        item.href === href &&
        item.id.startsWith("platform:navigation:"),
    ) ?? PLATFORM_FACTS.find((item) => item.href === href);
  return fact ? platformFactEvidence(fact) : undefined;
};

const hrefForRouteCategory: Partial<
  Record<AssistantUiContext["routeCategory"], string>
> = {
  dashboard: "/dashboard",
  proposals: "/proposals",
  proposal_creation: "/proposals/add-new-proposal",
  email: "/email",
  vendor_responses: "/vendor-responses",
  settings: "/settings",
};

export const platformFactsForUiContext = (
  uiContext: AssistantUiContext | null,
): AssistantPromptEvidence[] => {
  if (!uiContext) return [];
  const evidence: AssistantPromptEvidence[] = [];
  const href = hrefForRouteCategory[uiContext.routeCategory];
  if (href) {
    const route = platformFactEvidenceForHref(href);
    if (route) evidence.push(route);
  }
  if (uiContext.fieldKeyStatus === "valid" && uiContext.fieldKey) {
    const field = proposalFormGuidanceEvidenceForField(uiContext.fieldKey);
    if (field) evidence.unshift(field);
  }
  return evidence;
};

export const platformFactsForQuery = (
  query: string,
  limit = 12,
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

  const fieldGuidance = proposalFormGuidanceEvidenceForQuery(
    query,
    Math.min(3, limit),
  );
  return [
    ...fieldGuidance,
    ...facts.map(platformFactEvidence),
  ].slice(0, Math.max(1, limit));
};

export const platformFactsForConversation = (
  query: string,
  messages: readonly AssistantMessage[],
  currentUserMessageId?: string,
  limit = 12,
): AssistantPromptEvidence[] => {
  const historyLimit = requestsWholeConversationContext(query)
    ? ASSISTANT_CONVERSATION_FACT_QUERY_MESSAGES
    : requestsContextChain(query)
      ? ASSISTANT_CONTEXT_CHAIN_FACT_QUERY_MESSAGES
      : ASSISTANT_FOLLOW_UP_FACT_QUERY_MESSAGES;
  const availablePriorUserMessages = messages
    .filter(
      (message) =>
        message.id !== currentUserMessageId &&
        message.role === "user" &&
        message.status === "complete" &&
        Boolean(message.content.trim()),
    )
    .slice(-historyLimit)
    .map((message) => message.content);
  const priorUserMessages = requestsContextChain(query)
    ? (() => {
        const selected: string[] = [];
        for (
          let index = availablePriorUserMessages.length - 1;
          index >= 0;
          index -= 1
        ) {
          const content = availablePriorUserMessages[index];
          selected.push(content);
          if (hasStandalonePlatformTopic(content)) break;
        }
        return selected.reverse();
      })()
    : availablePriorUserMessages;

  return platformFactsForQuery(
    [query, ...priorUserMessages].join("\n"),
    limit,
  );
};
