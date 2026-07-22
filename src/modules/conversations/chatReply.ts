import Proposal from "../../../modal/proposalsModel";
import { documentIngestion } from "../documentIngestion/composition";
import { liveConversationReply } from "../liveAi/operations";
import { safeLog } from "../../shared/observability/safeTelemetry";
import { conversationRepository } from "./postgresConversationRepository";

const FALLBACK_REPLY = "Noted — I've saved that to this proposal. Add files or notes as sources on the right, then ask me to extract requirements or generate a cited draft. I'll raise clarification questions as I find gaps.";

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
  let reply = FALLBACK_REPLY;
  try {
    if (process.env.LIVE_AI_PILOT_ENABLED === "true") {
      const conversation = await conversationRepository.read({ ...ctx, proposalMongoId, limit: 12 });
      const sources = await documentIngestion.list(ctx.organizationMongoId, proposalMongoId, 20).catch(() => []);
      const proposalDoc = await Proposal.findOne({ _id: proposalMongoId, userId: ctx.actorUserMongoId })
        .select("event venueSchedule").lean<Record<string, unknown>>();
      const live = await liveConversationReply({
        history: conversation.messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
        proposalSummary: { event: proposalDoc?.event ?? {}, venueSchedule: proposalDoc?.venueSchedule ?? {} },
        sources: (sources as Array<Record<string, unknown>>).map((s) => ({
          filename: String(s.safeFilename ?? s.originalFilename ?? "source"),
          status: String(s.status ?? "unknown"),
        })),
        openQuestions: conversation.questions.filter((q: { status: string }) => q.status === "open").map((q: { prompt: string }) => q.prompt),
      }, organizationId ? { runType: "conversation_chat", runId: userMessageId, organizationId } : undefined);
      reply = live.reply;
    }
  } catch {
    safeLog("warn", "conversation_reply_fallback", { outcome: "fallback" });
  }
  await conversationRepository.appendAssistantMessage({ ...ctx, proposalMongoId, content: reply });
};
