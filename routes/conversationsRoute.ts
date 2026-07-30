import { Router } from "express";
import { conversationEvents, getConversation, patchConversationQuestion, postConversationMessage, postConversationSegment } from "../controller/conversationsController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const writeLimit = securityRateLimit({ name: "conversation-write", limit: 60, windowMs: 15 * 60_000 });
const streamLimit = securityRateLimit({ name: "conversation-stream", limit: 30, windowMs: 15 * 60_000 });

router.get("/proposals/:proposalId/conversation", authenticate, authorizeAction("proposal:read"), getConversation);
router.post("/proposals/:proposalId/conversation/messages", authenticate, authorizeAction("proposal:write"), writeLimit, postConversationMessage);
router.post("/proposals/:proposalId/conversation/segments", authenticate, authorizeAction("proposal:write"), writeLimit, postConversationSegment);
router.patch("/proposals/:proposalId/conversation/questions/:questionId", authenticate, authorizeAction("proposal:write"), writeLimit, patchConversationQuestion);
router.get("/proposals/:proposalId/conversation/events", authenticate, authorizeAction("proposal:read"), streamLimit, conversationEvents);

export default router;
