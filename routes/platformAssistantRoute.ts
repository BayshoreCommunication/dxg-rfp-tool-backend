import { Router } from "express";
import {
  createAssistantThread,
  getAssistantThread,
  listAssistantThreads,
  patchAssistantThread,
  streamAssistantMessage,
} from "../controller/platformAssistantController";
import { authenticate, authorizeAction } from "../middleware/auth";

const router = Router();

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
router.post(
  "/assistant/threads/:threadId/messages",
  authenticate,
  authorizeAction("assistant:use"),
  streamAssistantMessage,
);

export default router;
