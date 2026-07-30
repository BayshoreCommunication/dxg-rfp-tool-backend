import type {
  AssistantMessage,
  AssistantPromptEvidence,
  PlatformAssistantContext,
} from "./domain";
import {
  ASSISTANT_INTENT_VERSION,
  type AssistantIntent,
  type AssistantIntentClassification,
} from "./intentRouter";
import type { AssistantProposalContextSource } from "./ports";

const proposalContextIntents = new Set<AssistantIntent>([
  "proposal_specific_request",
  "proposal_review",
  "pre_send_checklist",
  "equipment_scope_review",
  "budget_estimation",
  "historical_reference_request",
  "ambiguous",
]);

export const resolveAssistantProposalContext = async (input: {
  source?: AssistantProposalContextSource;
  context: PlatformAssistantContext;
  query: string;
  history: readonly AssistantMessage[];
  currentUserMessageId: string;
  intent: AssistantIntentClassification;
}): Promise<{
  intent: AssistantIntentClassification;
  evidence: AssistantPromptEvidence[];
}> => {
  if (
    !input.source ||
    (!proposalContextIntents.has(input.intent.intent) &&
      !/\bproposals?\b/i.test(input.query))
  ) {
    return { intent: input.intent, evidence: [] };
  }

  try {
    const resolution = await input.source.resolve({
      ...input.context,
      query: input.query,
      recentUserMessages: input.history
        .filter(
          (message) =>
            message.id !== input.currentUserMessageId &&
            message.role === "user" &&
            message.status === "complete",
        )
        .map((message) => message.content),
    });
    if (resolution.state === "portfolio_summary") {
      return {
        intent: {
          intent: "proposal_specific_request",
          version: ASSISTANT_INTENT_VERSION,
          source: "deterministic",
          confidence: "high",
        },
        evidence: resolution.evidence,
      };
    }
    if (resolution.state !== "matched") {
      return { intent: input.intent, evidence: [] };
    }
    return {
      intent: {
        intent: "proposal_specific_request",
        version: ASSISTANT_INTENT_VERSION,
        source: "deterministic",
        confidence: "high",
      },
      evidence: resolution.evidence,
    };
  } catch {
    // Proposal lookup is additive context. A temporary Mongo read issue must
    // preserve the existing safe selector/clarification behavior.
    return { intent: input.intent, evidence: [] };
  }
};
