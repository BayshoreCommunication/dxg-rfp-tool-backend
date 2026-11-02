import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import type { MemberActor, MemberManagement, MemberResult } from "../src/modules/organizationMembers/application/manageMembers";
import { memberManagement as defaultMemberManagement } from "../src/modules/organizationMembers/composition";

const actorFrom = (req: AuthRequest): MemberActor | null => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) return null;
  return {
    organizationId: user.organizationId,
    userId: user.userId,
    roles: user.roles ?? [],
    sessionId: user.sessionId,
    correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
  };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
const queryString = (req: AuthRequest, key: string): string | undefined =>
  typeof req.query[key] === "string" ? (req.query[key] as string) : undefined;
const param = (req: AuthRequest, key: string): string => String(req.params[key] ?? "");

const send = <T extends object>(res: Response, result: MemberResult<T>): void => {
  if (!result.ok) {
    res.status(result.status).json({ success: false, code: result.code, message: result.message, ...(result.details ?? {}) });
    return;
  }
  const { ok: _ok, ...data } = result as { ok: true } & T;
  res.json({ success: true, data });
};

export const createOrganizationMembersController = (members: MemberManagement = defaultMemberManagement) => {
  const handle = <T extends object>(work: (actor: MemberActor, req: AuthRequest) => Promise<MemberResult<T>>) =>
    async (req: AuthRequest, res: Response): Promise<void> => {
      const actor = actorFrom(req);
      if (!actor) {
        res.status(401).json({ success: false, message: "Authentication required" });
        return;
      }
      try {
        send(res, await work(actor, req));
      } catch (error) {
        console.error("Organization members error:", error instanceof Error ? error.message : error);
        res.status(500).json({ success: false, code: "MEMBERS_INTERNAL_ERROR", message: "The member change could not be completed." });
      }
    };

  return {
    list: handle((actor, req) => members.list(actor, {
      q: queryString(req, "q"), status: queryString(req, "status"), role: queryString(req, "role"),
    })),
    changeRole: handle((actor, req) => members.changeRole(actor, { userId: param(req, "userId"), role: body(req).role, version: body(req).version })),
    changeTeams: handle((actor, req) => members.changeTeams(actor, { userId: param(req, "userId"), teamIds: body(req).teamIds, version: body(req).version })),
    deactivate: handle((actor, req) => members.deactivate(actor, { userId: param(req, "userId"), version: body(req).version })),
    reactivate: handle((actor, req) => members.reactivate(actor, { userId: param(req, "userId"), version: body(req).version })),
    reassignRfps: handle((actor, req) => members.reassignRfps(actor, { fromUserId: param(req, "userId"), toUserId: body(req).toUserId, rfpIds: body(req).rfpIds })),
    transferOwnership: handle((actor, req) => members.transferOwnership(actor, { toUserId: body(req).toUserId, version: body(req).version })),
  };
};

export const organizationMembersController = createOrganizationMembersController();
