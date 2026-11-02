import { hasOrganizationAction } from "../../identity/domain/authorizationPolicy";
import type { SecurityAuditWriter } from "../../auth/domain/ports/sessionPorts";
import {
  TeamError,
  type OrganizationMemberDirectory,
  type TeamActor,
  type TeamRecord,
  type TeamRepository,
  type TeamSummary,
  type TeamView,
} from "../domain";

type Dependencies = {
  teams: TeamRepository;
  directory: OrganizationMemberDirectory;
  audit: SecurityAuditWriter;
  isValidId(value: string): boolean;
  now?: () => Date;
};

const MAX_NAME_LENGTH = 120;
// Manager scope also needs the role (rfpAccessPolicy); Owners and Admins already see every RFP.
const MANAGER_ROLES = ["team_manager"];

const teamName = (value: unknown): string => {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new TeamError("INVALID_TEAM_NAME", `Team name must be 1 to ${MAX_NAME_LENGTH} characters.`, 400);
  }
  return name;
};

const teamNameTaken = () => new TeamError("TEAM_NAME_TAKEN", "An active team already has this name.", 409);
const teamNotFound = () => new TeamError("TEAM_NOT_FOUND", "Team not found.", 404);
const memberNotFound = () => new TeamError("MEMBER_NOT_FOUND", "Member not found in this organization.", 404);

export const createTeamAdministration = (dependencies: Dependencies) => {
  const { teams, directory, audit } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  const canManage = (actor: TeamActor) => hasOrganizationAction(actor.roles, "organization:manage");
  const requireManager = (actor: TeamActor) => {
    if (!canManage(actor)) throw new TeamError("TEAM_ADMIN_REQUIRED", "Only Owners and Admins can manage teams.", 403);
  };

  const record = (actor: TeamActor, action: string, teamId: string, decision: "created" | "revoked" | "allowed", metadata: Record<string, unknown>) =>
    audit.append({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action,
      targetType: "team",
      targetId: teamId,
      decision,
      reason: action,
      correlationId: actor.correlationId,
      metadata,
    });

  const loadTeam = async (actor: TeamActor, teamId: string): Promise<TeamRecord> => {
    const team = dependencies.isValidId(teamId) ? await teams.findById(actor.organizationId, teamId) : null;
    if (!team) throw teamNotFound();
    return team;
  };
  const loadActiveTeam = async (actor: TeamActor, teamId: string): Promise<TeamRecord> => {
    const team = await loadTeam(actor, teamId);
    if (team.archived) throw new TeamError("TEAM_ARCHIVED", "Archived teams can't be changed.", 409);
    return team;
  };
  const loadActiveMember = async (actor: TeamActor, userId: string) => {
    const member = dependencies.isValidId(userId) ? await directory.find(actor.organizationId, userId) : null;
    if (!member || member.status !== "active") throw memberNotFound();
    return member;
  };
  const assertCanManageTeam = (member: { roles: readonly string[] }) => {
    if (!member.roles.some((role) => MANAGER_ROLES.includes(role))) {
      throw new TeamError("TEAM_MANAGER_ROLE_REQUIRED", "Only members with the Team Manager role can manage a team.", 422);
    }
  };

  const withMembers = async (organizationId: string, list: TeamRecord[]): Promise<TeamView[]> => {
    const members = await teams.members(organizationId, list.map((team) => team.id));
    return list.map((team) => ({
      ...team,
      members: members.filter((m) => m.teamId === team.id).map(({ userId, isManager }) => ({ userId, isManager })),
    }));
  };

  return {
    // Owners and Admins get every team with its members; other members get the active team
    // names, which is what they need to pick a proposal's team.
    async list(actor: TeamActor): Promise<TeamView[] | TeamSummary[]> {
      const all = await teams.list(actor.organizationId);
      if (canManage(actor)) return withMembers(actor.organizationId, all);
      return all.filter((team) => !team.archived).map(({ id, name }) => ({ id, name }));
    },

    async get(actor: TeamActor, teamId: string): Promise<TeamView> {
      requireManager(actor);
      const [team] = await withMembers(actor.organizationId, [await loadTeam(actor, teamId)]);
      return team;
    },

    async create(actor: TeamActor, input: { name: unknown }): Promise<TeamView> {
      requireManager(actor);
      const created = await teams.create({ organizationId: actor.organizationId, name: teamName(input.name), createdBy: actor.userId });
      if (created === "duplicate") throw teamNameTaken();
      await record(actor, "team.created", created.id, "created", { name: created.name });
      return { ...created, members: [] };
    },

    async rename(actor: TeamActor, teamId: string, input: { name: unknown }): Promise<TeamView> {
      requireManager(actor);
      const name = teamName(input.name);
      const previous = await loadActiveTeam(actor, teamId);
      const renamed = await teams.rename({ organizationId: actor.organizationId, teamId, name });
      if (renamed === "duplicate") throw teamNameTaken();
      if (!renamed) throw teamNotFound();
      await record(actor, "team.renamed", teamId, "allowed", { name: renamed.name, previousName: previous.name });
      const [team] = await withMembers(actor.organizationId, [renamed]);
      return team;
    },

    async archive(actor: TeamActor, teamId: string): Promise<TeamView> {
      requireManager(actor);
      await loadActiveTeam(actor, teamId);
      if (await teams.archive({ organizationId: actor.organizationId, teamId, at: now() })) {
        await record(actor, "team.archived", teamId, "revoked", {});
      }
      const [team] = await withMembers(actor.organizationId, [await loadTeam(actor, teamId)]);
      return team;
    },

    async addMember(actor: TeamActor, teamId: string, input: { userId: unknown; isManager?: unknown }): Promise<TeamView> {
      requireManager(actor);
      const userId = typeof input.userId === "string" ? input.userId : "";
      const isManager = input.isManager === true;
      const team = await loadActiveTeam(actor, teamId);
      const member = await loadActiveMember(actor, userId);
      if (isManager) assertCanManageTeam(member);
      const outcome = await teams.addMember({ organizationId: actor.organizationId, teamId, userId, isManager });
      if (outcome === "exists") throw new TeamError("TEAM_MEMBER_EXISTS", "This member is already on the team.", 409);
      await record(actor, "team.member_added", teamId, "created", { userId, isManager });
      const [view] = await withMembers(actor.organizationId, [team]);
      return view;
    },

    async removeMember(actor: TeamActor, teamId: string, userId: string): Promise<TeamView> {
      requireManager(actor);
      const team = await loadActiveTeam(actor, teamId);
      if (!dependencies.isValidId(userId) || !(await teams.removeMember({ organizationId: actor.organizationId, teamId, userId }))) {
        throw new TeamError("TEAM_MEMBER_NOT_FOUND", "This member is not on the team.", 404);
      }
      await record(actor, "team.member_removed", teamId, "revoked", { userId });
      const [view] = await withMembers(actor.organizationId, [team]);
      return view;
    },

    async setManager(actor: TeamActor, teamId: string, userId: string, input: { isManager: unknown }): Promise<TeamView> {
      requireManager(actor);
      if (typeof input.isManager !== "boolean") throw new TeamError("INVALID_TEAM_MANAGER", "isManager must be true or false.", 400);
      const team = await loadActiveTeam(actor, teamId);
      if (input.isManager) assertCanManageTeam(await loadActiveMember(actor, userId));
      if (!dependencies.isValidId(userId) || !(await teams.setManager({ organizationId: actor.organizationId, teamId, userId, isManager: input.isManager }))) {
        throw new TeamError("TEAM_MEMBER_NOT_FOUND", "This member is not on the team.", 404);
      }
      await record(actor, "team.manager_changed", teamId, input.isManager ? "created" : "revoked", { userId, isManager: input.isManager });
      const [view] = await withMembers(actor.organizationId, [team]);
      return view;
    },
  };
};

export type TeamAdministration = ReturnType<typeof createTeamAdministration>;
