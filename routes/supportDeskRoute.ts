import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { authenticate, authorize, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { uploadSupportAttachments } from "../middleware/upload";
import { supportDeskController as controller } from "../controller/supportDeskController";

const router = Router();

const userIdentity = (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown";

// A planner can open or reply to tickets at a human pace; the limit protects
// the inbox and the notification fan-out, not the read paths.
const customerWriteLimit = securityRateLimit({
  name: "support-customer-write",
  limit: 30,
  windowMs: 15 * 60_000,
  identity: userIdentity,
});

const agentGuard = [authenticate, authorize("admin", "super_admin", "superadmin")];

// Multer errors (size, count, type) become a 400 problem instead of a stack.
const receiveSupportAttachments = (req: Request, res: Response, next: NextFunction) => {
  uploadSupportAttachments(req, res, (err: unknown) => {
    if (err) {
      const message =
        err instanceof Error && err.message.includes("File too large")
          ? "Each attachment must be 10 MB or smaller."
          : err instanceof Error && err.message.includes("Too many files")
            ? "At most 3 attachments per message."
            : err instanceof Error
              ? err.message
              : "File upload error.";
      res.status(400).json({ success: false, code: "SUPPORT_ATTACHMENT_REJECTED", message });
      return;
    }
    next();
  });
};

// Planner side — any active organization member.
router.get("/support/tickets", authenticate, controller.listOwnTickets);
router.post("/support/tickets", authenticate, customerWriteLimit, controller.createTicket);
router.get("/support/tickets/unread-count", authenticate, controller.ownUnreadCount);
router.get("/support/tickets/:ticketId", authenticate, controller.getOwnTicket);
router.post("/support/tickets/:ticketId/messages", authenticate, customerWriteLimit, controller.replyToOwnTicket);
router.post("/support/tickets/:ticketId/resolve", authenticate, customerWriteLimit, controller.resolveOwnTicket);
router.post("/support/attachments", authenticate, customerWriteLimit, receiveSupportAttachments, controller.uploadOwnAttachments);
router.get("/support/tickets/:ticketId/attachments/:attachmentId", authenticate, controller.ownAttachmentUrl);

// DXG agent side — administrative roles only.
router.get("/admin/support/tickets", ...agentGuard, controller.listInbox);
router.get("/admin/support/metrics", ...agentGuard, controller.metrics);
router.get("/admin/support/agents", ...agentGuard, controller.listAgents);
router.get("/admin/support/canned-replies", ...agentGuard, controller.listCannedReplies);
router.post("/admin/support/canned-replies", ...agentGuard, controller.createCannedReply);
router.patch("/admin/support/canned-replies/:id", ...agentGuard, controller.updateCannedReply);
router.delete("/admin/support/canned-replies/:id", ...agentGuard, controller.deleteCannedReply);
router.get("/admin/support/tickets/:ticketId", ...agentGuard, controller.getTicket);
router.post("/admin/support/tickets/:ticketId/messages", ...agentGuard, controller.reply);
router.post("/admin/support/tickets/:ticketId/notes", ...agentGuard, controller.addInternalNote);
router.patch("/admin/support/tickets/:ticketId", ...agentGuard, controller.updateTicket);
router.post("/admin/support/attachments", ...agentGuard, receiveSupportAttachments, controller.uploadAgentAttachments);
router.get("/admin/support/tickets/:ticketId/attachments/:attachmentId", ...agentGuard, controller.agentAttachmentUrl);

export default router;
