import type {
  AssistantPromptEvidence,
  AssistantPromptInput,
  AssistantProviderResponse,
} from "./domain";
import type { AssistantResponseProvider } from "./ports";

const injectionPattern =
  /\b(ignore (?:all |the )?(?:previous|system|developer)|system prompt|developer message|jailbreak|override instructions)\b/i;

const idsPresent = (
  evidence: readonly AssistantPromptEvidence[],
  ids: readonly string[],
): string[] => {
  const available = new Set(evidence.map((item) => item.id));
  return ids.filter((id) => available.has(id));
};

const result = (
  kind: AssistantProviderResponse["kind"],
  content: string,
  citationIds: string[] = [],
): AssistantProviderResponse => ({ kind, content, citationIds });

const isHowToQuestion = (query: string): boolean =>
  /^(how|where|what|when|why|explain|show me|help me understand)\b/i.test(query.trim());

const isActionRequest = (query: string): boolean =>
  !isHowToQuestion(query) &&
  (/^(?:please\s+)?(?:create|publish|send|delete|edit|change|update|book|reserve|schedule|email|contact)\b/i.test(
    query.trim(),
  ) ||
    /\b(?:publish|send|delete|edit|change|update|book|reserve|schedule)\b.{0,32}\b(?:my|this|it|for me)\b/i.test(
      query,
    ) ||
    /\b(?:do it|do that|on my behalf|for me)\b/i.test(query));

const isFormattingFollowUp = (query: string): boolean =>
  /\b(?:shorten|shorter|concise|brief|reformat|bullets?)\b/i.test(query);

const previousAssistantContent = (
  input: AssistantPromptInput,
): string | undefined =>
  [...input.history]
    .reverse()
    .find((message) => message.role === "assistant")
    ?.content.trim();

const shortenedPreviousAnswer = (content: string): string => {
  const listItems = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
  if (listItems.length) {
    return listItems.map((item) => `- ${item.slice(0, 180)}`).join("\n");
  }
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 4);
  return sentences.length
    ? sentences.map((sentence) => `- ${sentence.slice(0, 180)}`).join("\n")
    : content.slice(0, 600);
};

const relevantPlatformCitationIds = (
  input: AssistantPromptInput,
): string[] =>
  input.evidence
    .filter((item) => item.sourceType === "platform_fact")
    .slice(0, 4)
    .map((item) => item.id);

const relevantOperatingGuidance = (
  input: AssistantPromptInput,
): AssistantPromptEvidence[] =>
  input.evidence.filter((item) => {
    if (item.sourceType !== "operating_guidance" || injectionPattern.test(item.content)) {
      return false;
    }
    const normalized = item.content.toLowerCase();
    const eventTerms = [
      "event",
      "venue",
      "attendee",
      "schedule",
      "room",
      "audio",
      "video",
      "lighting",
      "streaming",
      "recording",
      "budget",
      "deadline",
    ];
    return eventTerms.filter((term) => normalized.includes(term)).length >= 2;
  });

export class DeterministicAssistantProvider implements AssistantResponseProvider {
  readonly provider = "mock";
  readonly model = "platform-assistant-deterministic-v1";

  async generate(input: AssistantPromptInput): Promise<AssistantProviderResponse> {
    const query = input.userMessage.trim();
    const normalized = query.toLowerCase();

    if (isActionRequest(query)) {
      if (/\b(?:book|reserve)\b.*\b(?:venue|room|hotel|travel)\b/i.test(normalized)) {
        return result(
          "refusal",
          "I can’t book or reserve a venue for you. I can help you prepare the venue, schedule, room, attendance, and production requirements, then you can record them in [Create a proposal](/proposals/add-new-proposal) and contact venues yourself.",
          idsPresent(input.evidence, [
            "platform:assistant:scope",
            "platform:event:planning-brief",
            "platform:navigation:create-proposal",
          ]),
        );
      }
      if (/\bdelete\b/i.test(normalized)) {
        const citationIds = idsPresent(input.evidence, [
          "platform:assistant:scope",
          "platform:navigation:proposals",
        ]);
        const hasProposals = citationIds.includes(
          "platform:navigation:proposals",
        );
        return result(
          "refusal",
          hasProposals
            ? "I can’t delete a proposal or confirm that it was deleted. Open [Proposals](/proposals), find the proposal, use its trash/delete control, review the confirmation, and complete the deletion yourself."
            : "I can’t delete a proposal or confirm that it was deleted. Use the proposal list’s trash/delete control and review the confirmation before completing the deletion yourself.",
          citationIds,
        );
      }
      const citationIds = idsPresent(input.evidence, [
        "platform:assistant:scope",
        "platform:navigation:create-proposal",
        "platform:proposal:guided-intake",
        "platform:navigation:proposals",
        "platform:navigation:email",
      ]);
      const hasWorkflowLinks = [
        "platform:navigation:create-proposal",
        "platform:navigation:proposals",
        "platform:navigation:email",
      ].every((id) => citationIds.includes(id));
      return result(
        "refusal",
        hasWorkflowLinks
          ? "I can guide you, but I can’t create, publish, or email a proposal for you. Start at [Create a proposal](/proposals/add-new-proposal), complete and review the guided intake, explicitly generate or update the RFP, then use its send action from [Proposals](/proposals). Proposal email activity is available in [Email](/email)."
          : "I can explain the steps, but I cannot edit, publish, delete, or send anything for you. Tell me which workflow you want to understand and I’ll guide you through it.",
        citationIds,
      );
    }

    if (isFormattingFollowUp(query)) {
      const previous = previousAssistantContent(input);
      const citationIds = relevantPlatformCitationIds(input);
      if (previous && citationIds.length) {
        return result(
          "answer",
          shortenedPreviousAnswer(previous),
          citationIds,
        );
      }
    }

    if (
      /\b(?:what(?:'s| is) missing|status|review|summari[sz]e|look at)\b.*\b(?:my|this)\s+proposal\b/i.test(
        normalized,
      )
    ) {
      return result(
        "clarification",
        "I don’t automatically have access to a specific proposal here. Open that proposal’s dedicated assistant from the Proposals page, or ask me a general workflow question.",
        idsPresent(input.evidence, ["platform:assistant:proposal-workspace"]),
      );
    }

    if (
      /\b(?:difference|different|which assistant|proposal assistant|general assistant)\b/i.test(
        normalized,
      )
    ) {
      return result(
        "answer",
        "Use this AI Assistant for general platform, onboarding, workflow, and event guidance. Use a proposal’s dedicated assistant when you want to work with that proposal’s information and sources. You can open proposals from [Proposals](/proposals).",
        idsPresent(input.evidence, [
          "platform:assistant:scope",
          "platform:assistant:proposal-workspace",
        ]),
      );
    }

    if (/\bvendor\b.*\bresponses?\b|\bresponses?\b.*\bvendor\b/i.test(normalized)) {
      return result(
        "answer",
        "Open [Vendor Responses](/vendor-responses) to view responses available to you, including unread filtering and pagination.",
        idsPresent(input.evidence, ["platform:navigation:vendor-responses"]),
      );
    }

    if (/\bsettings?\b|\bprofile\b|\bbranding\b|\blogo\b/i.test(normalized)) {
      return result(
        "answer",
        "Open [Settings](/settings) to manage the supported profile and branding options for your account.",
        idsPresent(input.evidence, ["platform:navigation:settings"]),
      );
    }

    if (
      /\b(?:before|check|review)\b.*\b(?:send|sending)\b.*\bproposal\b|\bproposal\b.*\b(?:before|check|review)\b.*\b(?:send|sending)\b/i.test(
        normalized,
      )
    ) {
      return result(
        "answer",
        "Before sending, verify the event, venue, schedule, room and production scope, conditional hybrid/creative/recording needs, technical and insurance requirements, budget and deadlines, uploads or co-vendor responsibilities, and contact/recipient details. Review the generated RFP for gaps, then use its send action from [Proposals](/proposals).",
        idsPresent(input.evidence, [
          "platform:proposal:pre-send-checklist",
          "platform:navigation:proposals",
        ]),
      );
    }

    if (
      /\b(?:create|start|new|send)\b.*\bproposal\b|\bproposal\b.*\b(?:workflow|steps|send)\b/i.test(
        normalized,
      )
    ) {
      return result(
        "answer",
        "Open [Create a proposal](/proposals/add-new-proposal). If the guided form is enabled, optionally upload a source file or continue without one, then complete: Event Overview; Venue & Schedule; Room Specifications; Hybrid & Virtual when applicable; Content & Creative; Video Recording; Venue & Technical; Investment & Evaluation; Uploads & Co-Vendors; and Contact & Submit. Save a draft or explicitly generate/update the RFP at the end. The separate optional proposal-assistant experience uses five phases.",
        idsPresent(input.evidence, [
          "platform:navigation:create-proposal",
          "platform:proposal:guided-intake",
          "platform:proposal:workflow",
        ]),
      );
    }

    if (/\b(?:event|venue|attendee|production|av)\b.*\b(?:checklist|gather|need|plan|information)\b/i.test(normalized)) {
      const guidance = relevantOperatingGuidance(input);
      if (!guidance.length) {
        return result(
          "abstention",
          "I don’t have enough approved event guidance in this workspace to give you a reliable checklist. You can ask a platform workflow question, or have an administrator add reviewed operating guidance.",
        );
      }
      return result(
        "answer",
        "A useful event brief starts with dates and venue, attendee count and format, room schedule, production needs such as audio/video/lighting, streaming or recording requirements, accessibility needs, budget, and decision deadlines.",
        [guidance[0].id],
      );
    }

    if (/\b(?:proposal|proposals)\b/i.test(normalized)) {
      return result(
        "answer",
        "Open [Proposals](/proposals) to see your proposals and access their create, inspect, edit, and send entry points.",
        idsPresent(input.evidence, ["platform:navigation:proposals"]),
      );
    }

    if (/\b(?:dashboard|home|overview|activity)\b/i.test(normalized)) {
      return result(
        "answer",
        "Open the [Dashboard](/dashboard) for a high-level view of platform activity.",
        idsPresent(input.evidence, ["platform:navigation:dashboard"]),
      );
    }

    if (/\b(?:what can you do|how can you help|your scope)\b/i.test(normalized)) {
      return result(
        "answer",
        "I can explain RFPilot navigation, proposal workflows, event-planning concepts, and onboarding. I’m read-only, so I’ll guide you without changing or sending anything.",
        idsPresent(input.evidence, ["platform:assistant:scope"]),
      );
    }

    return result(
      "abstention",
      "I don’t have enough approved information to answer that reliably. Try asking about RFPilot navigation, proposal workflows, event planning, or onboarding.",
    );
  }
}

export const deterministicAssistantProvider = new DeterministicAssistantProvider();
