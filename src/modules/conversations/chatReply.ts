import Proposal from "../../../modal/proposalsModel";
import { documentIngestion } from "../documentIngestion/composition";
import { liveConversationReply } from "../liveAi/operations";
import { safeLog } from "../../shared/observability/safeTelemetry";
import { conversationRepository } from "./postgresConversationRepository";
import {
  asksForRoomScheduleHelp,
  ROOM_SCHEDULE_ASSISTANT_ACTIONS,
  type AssistantActionId,
} from "./domain";
import { buildSelectedProposalKnowledge } from "./selectedProposalKnowledge";
import { attachmentReceiptReply } from "./attachmentReply";
import {
  conversationExtractionEnabled,
  isSelfContainedBrief,
  isSubstantive,
} from "./segmentation";

const FIRST_TURN_REPLY = "Absolutely — I’ll help you build this proposal. We’ll start with a few key event details, then I’ll prepare a first draft for you to review. Answer the first question below whenever you’re ready.";
const FOLLOW_UP_REPLY = "Thanks — I’ll use that as conversation context while we build the proposal. Continue with the next guided question below whenever you’re ready.";
const ROOM_SCHEDULE_REPLY = "For several room functions, use the room schedule template. Download it, add one row per function, repeat the same Room Name for functions sharing a physical room, then open Room Specifications and upload the completed .xlsx file. Those functions will share the room’s AV specifications.";
const DETAILED_BRIEF_REPLY = "Thanks — I’m reading this as an event brief, just like an uploaded TXT, PDF, or DOC file. I’ll add clear details to empty proposal fields, keep existing values unchanged, and ask only about anything missing or unclear.";
export const CHAT_PROVIDER_UNAVAILABLE_REPLY = "Thanks — your message is still available in this conversation. Automatic AI processing is temporarily unavailable, so its details may not be filled in yet. You can continue with the questions below or try extraction again later.";

type Ctx = { organizationMongoId: string; actorUserMongoId: string; correlationId: string };

export type ChatReply = { reply: string; actions: AssistantActionId[] };

type ConversationSnapshot = Awaited<ReturnType<typeof conversationRepository.read>>;

const deterministicChatReply = (
  conversation: ConversationSnapshot,
  userMessageId?: string,
): ChatReply & { useLiveAi: boolean } => {
  const latestUserMessage = userMessageId
    ? conversation.messages.find(message => message.id === userMessageId && message.role === "user")
    : [...conversation.messages].reverse().find((message: { role: string }) => message.role === "user");
  const userTurnCount = conversation.messages.filter((message: { role: string }) => message.role === "user").length;
  const latestContent = String(latestUserMessage?.content ?? "");
  const attachmentReply = attachmentReceiptReply(latestUserMessage?.attachments ?? []);
  if (attachmentReply) return { reply: attachmentReply, actions: [], useLiveAi: false };
  if (asksForRoomScheduleHelp(latestContent)) {
    return {
      reply: ROOM_SCHEDULE_REPLY,
      actions: [...ROOM_SCHEDULE_ASSISTANT_ACTIONS],
      useLiveAi: false,
    };
  }
  const detailedBrief =
    conversationExtractionEnabled() &&
    isSubstantive(latestContent) &&
    isSelfContainedBrief(latestContent);
  if (detailedBrief) return { reply: DETAILED_BRIEF_REPLY, actions: [], useLiveAi: false };
  return {
    reply: userTurnCount <= 1 ? FIRST_TURN_REPLY : FOLLOW_UP_REPLY,
    actions: [],
    useLiveAi: process.env.LIVE_AI_PILOT_ENABLED === "true",
  };
};

// Chat jobs build a governed reply in the durable worker: live when the pilot
// is enabled, a deterministic acknowledgement otherwise. Temporary provider
// failures are retried by the job system; terminal model/feature failures use
// the deterministic response without ever rolling back the accepted message.
export const buildChatReply = async (
  ctx: Ctx,
  proposalMongoId: string,
  organizationId: string | undefined,
  generationId: string,
  userMessageId?: string,
): Promise<ChatReply> => {
  let reply = FIRST_TURN_REPLY;
  let actions: AssistantActionId[] = [];
  try {
    const conversation = await conversationRepository.read({ ...ctx, proposalMongoId, limit: 12 });
    const deterministic = deterministicChatReply(conversation, userMessageId);
    reply = deterministic.reply;
    actions = deterministic.actions;
    if (deterministic.useLiveAi) {
      const sources = await documentIngestion.list(ctx.organizationMongoId, proposalMongoId, 20).catch(() => []);
      const proposalDoc = await Proposal.findOne({
        _id: proposalMongoId,
        userId: ctx.actorUserMongoId,
        isArchived: { $ne: true },
        $or: [
          { organizationId: ctx.organizationMongoId },
          { organizationId: { $exists: false } },
          { organizationId: null },
        ],
      })
        .select(
          "status isDraft version event venueSchedule roomByRoom production hybridVirtual contentCreative venue budget",
        )
        .lean<Record<string, unknown>>();
      const live = await liveConversationReply({
        history: conversation.messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
        proposalSummary: buildSelectedProposalKnowledge(proposalDoc ?? {}),
        sources: (sources as Array<Record<string, unknown>>).map((s) => ({
          filename: String(s.safeFilename ?? s.originalFilename ?? "source"),
          status: String(s.status ?? "unknown"),
        })),
        openQuestions: conversation.questions.filter((q: { status: string }) => q.status === "open").map((q: { prompt: string }) => q.prompt),
      }, organizationId ? { runType: "conversation_chat", runId: generationId, organizationId } : undefined);
      reply = live.reply;
      actions = live.actions;
    }
  } catch (error) {
    // Temporary provider failures belong to the durable worker's retry loop;
    // after its retry budget is exhausted, the worker persists explicit
    // provider-unavailable guidance instead of leaving a red dead-end message.
    if ((error as { retryable?: boolean }).retryable) throw error;
    safeLog("warn", "conversation_reply_fallback", { outcome: "fallback" });
  }
  return { reply, actions };
};

// Retained for callers that deliberately need an immediate assistant turn.
// The proposal conversation controller now queues buildChatReply instead.
export const appendChatReply = async (
  ctx: Ctx,
  proposalMongoId: string,
  organizationId: string | undefined,
  generationId: string,
): Promise<void> => {
  const result = await buildChatReply(ctx, proposalMongoId, organizationId, generationId);
  await conversationRepository.appendAssistantMessage({ ...ctx, proposalMongoId, content: result.reply, actions: result.actions });
};
