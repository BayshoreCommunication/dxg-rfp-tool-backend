import fs from "node:fs/promises";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { SupportDeskError, type SupportActor } from "../src/modules/supportDesk/domain";
import type { AgentSupportDesk } from "../src/modules/supportDesk/application/agentSupportDesk";
import type { CustomerSupportDesk } from "../src/modules/supportDesk/application/customerSupportDesk";
import type { SupportAttachments } from "../src/modules/supportDesk/application/supportAttachments";
import type { SupportPresence } from "../src/modules/supportDesk/application/supportPresence";
import {
  agentSupportDesk as defaultAgentSupportDesk,
  customerSupportDesk as defaultCustomerSupportDesk,
  supportAttachments as defaultSupportAttachments,
  supportPresence as defaultSupportPresence,
} from "../src/modules/supportDesk/composition";

const actorFrom = (req: AuthRequest): SupportActor => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) {
    throw new SupportDeskError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  }
  return {
    userId: user.userId,
    organizationId: user.organizationId,
    role: user.role,
    roles: user.roles ?? [],
  };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

const query = (req: AuthRequest): Record<string, unknown> => req.query as Record<string, unknown>;

const fail = (res: Response, error: unknown): void => {
  if (error instanceof SupportDeskError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Support desk error:", error instanceof Error ? error.message : error);
  res.status(500).json({
    success: false,
    code: "SUPPORT_INTERNAL_ERROR",
    message: "The support desk request could not be completed.",
  });
};

const ok = (res: Response, data: unknown, status = 200): void => {
  res.status(status).json({ success: true, data });
};

type UploadedFile = { path: string; originalname: string; mimetype: string; size: number };

const uploadedFiles = (req: AuthRequest): UploadedFile[] => {
  const files = (req as AuthRequest & { files?: unknown }).files;
  return Array.isArray(files) ? (files as UploadedFile[]) : [];
};

// Multer has already written the files to the temp upload directory; they
// are removed whether or not the intake succeeds.
const discardTempFiles = async (files: readonly UploadedFile[]): Promise<void> => {
  await Promise.all(
    files.map((file) => fs.unlink(file.path).catch(() => undefined)),
  );
};

export const createSupportDeskController = (dependencies?: {
  customer?: CustomerSupportDesk;
  agent?: AgentSupportDesk;
  attachments?: SupportAttachments;
  presence?: SupportPresence;
}) => {
  const customer = dependencies?.customer ?? defaultCustomerSupportDesk;
  const agent = dependencies?.agent ?? defaultAgentSupportDesk;
  const attachments = dependencies?.attachments ?? defaultSupportAttachments;
  const presence = dependencies?.presence ?? defaultSupportPresence;

  const intake = async (
    req: AuthRequest,
    res: Response,
    upload: SupportAttachments["uploadForCustomer"],
  ) => {
    const files = uploadedFiles(req);
    try {
      ok(
        res,
        {
          attachments: await upload(
            actorFrom(req),
            files.map((file) => ({
              localPath: file.path,
              originalName: file.originalname,
              mimeType: file.mimetype,
              sizeBytes: file.size,
            })),
          ),
        },
        201,
      );
    } catch (error) {
      fail(res, error);
    } finally {
      await discardTempFiles(files);
    }
  };

  return {
    // Planner side
    async createTicket(req: AuthRequest, res: Response) {
      try {
        ok(res, await customer.createTicket(actorFrom(req), body(req)), 201);
      } catch (error) {
        fail(res, error);
      }
    },
    async listOwnTickets(req: AuthRequest, res: Response) {
      try {
        ok(res, await customer.listOwnTickets(actorFrom(req), query(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async ownUnreadCount(req: AuthRequest, res: Response) {
      try {
        ok(res, { unreadTickets: await customer.ownUnreadCount(actorFrom(req)) });
      } catch (error) {
        fail(res, error);
      }
    },
    async getOwnTicket(req: AuthRequest, res: Response) {
      try {
        ok(res, await customer.getOwnTicket(actorFrom(req), req.params.ticketId));
      } catch (error) {
        fail(res, error);
      }
    },
    async replyToOwnTicket(req: AuthRequest, res: Response) {
      try {
        ok(res, await customer.replyToOwnTicket(actorFrom(req), req.params.ticketId, body(req)), 201);
      } catch (error) {
        fail(res, error);
      }
    },
    async resolveOwnTicket(req: AuthRequest, res: Response) {
      try {
        ok(res, await customer.resolveOwnTicket(actorFrom(req), req.params.ticketId));
      } catch (error) {
        fail(res, error);
      }
    },
    async uploadOwnAttachments(req: AuthRequest, res: Response) {
      await intake(req, res, attachments.uploadForCustomer);
    },
    async ownAttachmentUrl(req: AuthRequest, res: Response) {
      try {
        ok(res, await attachments.customerDownload(actorFrom(req), req.params.ticketId, req.params.attachmentId));
      } catch (error) {
        fail(res, error);
      }
    },

    // Agent side
    async presence(req: AuthRequest, res: Response) {
      try {
        ok(res, await presence.heartbeat(actorFrom(req), req.params.ticketId, body(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async leavePresence(req: AuthRequest, res: Response) {
      try {
        await presence.leave(actorFrom(req), req.params.ticketId);
        ok(res, { left: true });
      } catch (error) {
        fail(res, error);
      }
    },
    async listInbox(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.listInbox(actorFrom(req), query(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async metrics(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.metrics(actorFrom(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async listAgents(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.listAgents(actorFrom(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async getTicket(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.getTicket(actorFrom(req), req.params.ticketId));
      } catch (error) {
        fail(res, error);
      }
    },
    async reply(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.reply(actorFrom(req), req.params.ticketId, body(req)), 201);
      } catch (error) {
        fail(res, error);
      }
    },
    async addInternalNote(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.addInternalNote(actorFrom(req), req.params.ticketId, body(req)), 201);
      } catch (error) {
        fail(res, error);
      }
    },
    async updateTicket(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.updateTicket(actorFrom(req), req.params.ticketId, body(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async listCannedReplies(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.listCannedReplies(actorFrom(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async createCannedReply(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.createCannedReply(actorFrom(req), body(req)), 201);
      } catch (error) {
        fail(res, error);
      }
    },
    async updateCannedReply(req: AuthRequest, res: Response) {
      try {
        ok(res, await agent.updateCannedReply(actorFrom(req), req.params.id, body(req)));
      } catch (error) {
        fail(res, error);
      }
    },
    async deleteCannedReply(req: AuthRequest, res: Response) {
      try {
        await agent.deleteCannedReply(actorFrom(req), req.params.id);
        ok(res, { deleted: true });
      } catch (error) {
        fail(res, error);
      }
    },
    async uploadAgentAttachments(req: AuthRequest, res: Response) {
      await intake(req, res, attachments.uploadForAgent);
    },
    async agentAttachmentUrl(req: AuthRequest, res: Response) {
      try {
        ok(res, await attachments.agentDownload(actorFrom(req), req.params.ticketId, req.params.attachmentId));
      } catch (error) {
        fail(res, error);
      }
    },
  };
};

export const supportDeskController = createSupportDeskController();
