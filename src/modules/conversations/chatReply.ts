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

const FIRST_TURN_REPLY = "Absolutely — I’ll help you build this proposal. We’ll start with a few key event details, then I’ll prepare a first draft for you to review. Answer the first question below whenever you’re ready.";
const FOLLOW_UP_REPLY = "Thanks — I’ll use that as conversation context while we build the proposal. Continue with the next guided question below whenever you’re ready.";
const ROOM_SCHEDULE_REPLY = "For several room functions, use the room schedule template. Download it, add one row per function, repeat the same Room Name for functions sharing a physical room, then open Room Specifications and upload the completed .xlsx file. Those functions will share the room’s AV specifications.";

type Ctx = { organizationMongoId: string; actorUserMongoId: string; correlationId: string };

// Chat turns get a synchronous assistant reply: live and governed when the
// pilot is enabled, a deterministic acknowledgment otherwise. Reply failures
// never fail the user's message.
export const appendChatReply = async (
  ctx: Ctx,
  proposalMongoId: string,
  organizationId: string | undefined,
  userMessageId: string,
): Promise<void> => {
  let reply = FIRST_TURN_REPLY;
  let actions: AssistantActionId[] = [];
  try {
    const conversation = await conversationRepository.read({ ...ctx, proposalMongoId, limit: 12 });
    const latestUserMessage = [...conversation.messages].reverse().find((message: { role: string }) => message.role === "user");
    const userTurnCount = conversation.messages.filter((message: { role: string }) => message.role === "user").length;
    reply = userTurnCount <= 1 ? FIRST_TURN_REPLY : FOLLOW_UP_REPLY;
    const explicitlyAsked = asksForRoomScheduleHelp(String(latestUserMessage?.content ?? ""));
    if (explicitlyAsked) {
      reply = ROOM_SCHEDULE_REPLY;
      actions = [...ROOM_SCHEDULE_ASSISTANT_ACTIONS];
    } else if (process.env.LIVE_AI_PILOT_ENABLED === "true") {
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
          "status isDraft version event venueSchedule roomByRoom production hybridVirtual contentCreative videoRecordingStep venue budget",
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
      }, organizationId ? { runType: "conversation_chat", runId: userMessageId, organizationId } : undefined);
      reply = live.reply;
      actions = live.actions;
    }
  } catch {
    safeLog("warn", "conversation_reply_fallback", { outcome: "fallback" });
  }
  await conversationRepository.appendAssistantMessage({ ...ctx, proposalMongoId, content: reply, actions });
};
