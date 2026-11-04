import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { ShareError, type ShareActor } from "../src/modules/rfpSharing/domain";
import type { RfpSharing } from "../src/modules/rfpSharing/application/manageRfpShares";
import { rfpSharing } from "../src/modules/rfpSharing/composition";

const actorFrom = (req: AuthRequest): ShareActor => {
  if (!req.rfpActor) throw new ShareError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { rfpActor: req.rfpActor, correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID() };
};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof ShareError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Proposal sharing error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "SHARING_INTERNAL_ERROR", message: "The sharing request could not be completed." });
};

export const createRfpSharesController = (sharing: RfpSharing = rfpSharing) => {
  const handle = (run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(200).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  return {
    list: handle((req) => sharing.list(actorFrom(req), req.params.proposalId)),
    grant: handle((req) => sharing.grant(actorFrom(req), req.params.proposalId, req.params.userId, {
      permission: (req.body as Record<string, unknown> | undefined)?.permission,
    })),
    revoke: handle((req) => sharing.revoke(actorFrom(req), req.params.proposalId, req.params.userId)),
  };
};

export const rfpSharesController = createRfpSharesController();
