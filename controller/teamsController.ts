import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { TeamError, type TeamActor } from "../src/modules/teams/domain";
import type { TeamAdministration } from "../src/modules/teams/application/manageTeams";
import { teamAdministration } from "../src/modules/teams/composition";

const actorFrom = (req: AuthRequest): TeamActor => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) throw new TeamError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    userId: user.userId,
    organizationId: user.organizationId,
    roles: user.roles ?? [],
    correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
  };
};

const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof TeamError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Teams error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "TEAMS_INTERNAL_ERROR", message: "The team request could not be completed." });
};

export const createTeamsController = (teams: TeamAdministration = teamAdministration) => {
  const handle = (status: number, run: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
    try {
      res.status(status).json({ success: true, data: await run(req) });
    } catch (error) {
      fail(res, error);
    }
  };
  return {
    list: handle(200, (req) => teams.list(actorFrom(req))),
    get: handle(200, (req) => teams.get(actorFrom(req), req.params.teamId)),
    create: handle(201, (req) => teams.create(actorFrom(req), { name: body(req).name })),
    rename: handle(200, (req) => teams.rename(actorFrom(req), req.params.teamId, { name: body(req).name })),
    archive: handle(200, (req) => teams.archive(actorFrom(req), req.params.teamId)),
    addMember: handle(201, (req) => teams.addMember(actorFrom(req), req.params.teamId, { userId: body(req).userId, isManager: body(req).isManager })),
    removeMember: handle(200, (req) => teams.removeMember(actorFrom(req), req.params.teamId, req.params.userId)),
    setManager: handle(200, (req) => teams.setManager(actorFrom(req), req.params.teamId, req.params.userId, { isManager: body(req).isManager })),
  };
};

export const teamsController = createTeamsController();
