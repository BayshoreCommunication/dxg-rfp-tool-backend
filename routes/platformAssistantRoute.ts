import { Router } from "express";
import {
  createAssistantThread,
  getAssistantAccess,
  getAssistantQualityReport,
  getAssistantThread,
  listAssistantThreads,
  patchAssistantThread,
  putAssistantFeedback,
  recordAssistantProductEvent,
  streamAssistantMessage,
} from "../controller/platformAssistantController";
import { authenticate, authorizeAction } from "../middleware/auth";

const router = Router();

router.get(
  "/assistant/access",
  authenticate,
  authorizeAction("assistant:use"),
  getAssistantAccess,
);
router.get(
  "/ai/assistant-quality",
  authenticate,
  authorizeAction("security:admin"),
  getAssistantQualityReport,
);
router.post(
  "/assistant/analytics/events",
  authenticate,
  authorizeAction("assistant:use"),
  recordAssistantProductEvent,
);
router.get(
  "/assistant/threads",
  authenticate,
  authorizeAction("assistant:use"),
  listAssistantThreads,
);
router.post(
  "/assistant/threads",
  authenticate,
  authorizeAction("assistant:use"),
  createAssistantThread,
);
router.get(
  "/assistant/threads/:threadId",
  authenticate,
  authorizeAction("assistant:use"),
  getAssistantThread,
);
router.patch(
  "/assistant/threads/:threadId",
  authenticate,
  authorizeAction("assistant:use"),
  patchAssistantThread,
);
router.put(
  "/assistant/threads/:threadId/messages/:messageId/feedback",
  authenticate,
  authorizeAction("assistant:use"),
  putAssistantFeedback,
);
router.post(
  "/assistant/threads/:threadId/messages",
  authenticate,
  authorizeAction("assistant:use"),
  streamAssistantMessage,
);

export default router;
