import { isPlanStaff, type PlanStaff } from "../../entitlements/application/manageOrganizationPlans";
import { decideTeamsChange, invalidTeams, parseTeamSelection, teamsUnavailable, unknownTeams } from "../../organizationMembers/domain/memberPolicy";
import type { MemberChangeAudit, MembershipStore, StaffMemberTeamsStore, TeamDirectory } from "../../organizationMembers/domain/ports";
import type { TeamAdministration } from "../../teams/application/manageTeams";
import { TeamError, staffTeamActor, type StaffTeamActor, type TeamChangeKind } from "../../teams/domain";
import {
  STAFF_TEAM_AUDIT,
  StaffAccessError,
  StaffMemberError,
  unmanageableStanding,
  type StaffMemberDirectory,
  type StaffTeamDetail,
  type StaffTeamDirectory,
} from "../domain";
import { allow, asTyped, fromRefusal, memberNotFound, parseReason, refused, stale, versionOf } from "./manageOrganizationMembers";
import { staffMemberView, staffTeamView, type StaffContentAudit } from "./readOrganizationContent";

/* Staff team management (owner decision, 2026-11-18; docs/DECISIONS.md). RFPilot staff create,
   rename and archive a team, add and remove a team member, set and unset a team manager, and set
   which teams a member is on, in a customer organization. The sibling of staff member management
   (manageOrganizationMembers.ts), built the same way.

   The rules are the customer's own. Team changes run through the team service the organization's
   Owner and Admins use (teams/application/manageTeams.ts) and its store; "set a member's teams"
   asks the same policy (organizationMembers/domain/memberPolicy.ts) and writes through the same
   team directory. So the refusals, the name uniqueness, the archived-team behaviour, "a manager
   must hold the Team Manager role", "a member must be an active member of the organization" and
   the optimistic version check are the ones the customer gets. What differs is the actor: staff
   are NOT members. They reach the team service as a staff actor made by `staffTeamActor`, which
   has no user id and no role in the organization; no membership is created, faked or written
   for them, and a team staff create has no `createdBy`.

   Tenant scope: the organization is the one in the path and nothing else. The team id, the
   member id and every id in `teamIds` are validated, and every read and write names the path's
   organization with them, so a team or member of another organization is "not found" (or, for
   `teamIds`, an unknown team). RFPilot's own organization and a legacy holding tenant are refused
   (409 ORGANIZATION_NOT_MANAGEABLE).

   Audit: after the staff check, every request leaves exactly ONE event, in the STAFF organization
   (`organizationId: staff.organizationId`), under a `platform.organization_team.*` action (or
   `platform.organization_member.teams_changed`): `allowed` for a change (or a request that found
   nothing to change), `denied` for a refusal. An applied change's event is inserted by the store
   in the SAME MongoDB transaction as the change, so a change is never applied without its
   record. Nothing is written to the customer organization's audit trail: none of `team.*` or
   `organization.member.teams_changed` is written when the actor is staff.

   Nothing here touches a proposal: a proposal's team is not changed by any of these routes.
   Sessions: none of these changes ends a session, here or in the customer flow. */

const ID = /^[a-f0-9]{24}$/;

type Dependencies = {
  directory: StaffMemberDirectory;
  teamDirectory: StaffTeamDirectory;
  /** The customer's team rules and store. Its member events are never written for a staff actor. */
  teams: Pick<TeamAdministration, "create" | "rename" | "archive" | "addMember" | "removeMember" | "setManager">;
  members: Pick<MembershipStore, "find">;
  memberTeams: Pick<TeamDirectory, "activeTeamIds"> & StaffMemberTeamsStore;
  /** Refusals, reads and requests that changed nothing. An applied change's event goes through the store. */
  audit: StaffContentAudit;
};

type Attempt = {
  staff: PlanStaff;
  action: string;
  targetType: "team" | "organization_membership";
  /** As the caller typed them: validated before they are used in a query. */
  organizationId: string;
  teamId: string;
  memberUserId: string;
  staffReason: string | null;
};

const ACTION: Record<TeamChangeKind, string> = {
  created: STAFF_TEAM_AUDIT.created,
  renamed: STAFF_TEAM_AUDIT.renamed,
  archived: STAFF_TEAM_AUDIT.archived,
  member_added: STAFF_TEAM_AUDIT.memberAdded,
  member_removed: STAFF_TEAM_AUDIT.memberRemoved,
  manager_changed: STAFF_TEAM_AUDIT.managerChanged,
};

const teamNotFound = () => refused(404, "TEAM_NOT_FOUND", "Team not found.");

// The answer: the team and its members through the staff reads' allowlists, each member with
// the version a change of that member's teams needs.
const teamDetailView = (detail: StaffTeamDetail) => ({
  team: staffTeamView(detail.team),
  members: detail.members.map((entry) => ({ member: staffMemberView(entry.member), version: entry.version, isManager: entry.isManager === true })),
});

export const createStaffTeamManagement = (dependencies: Dependencies) => {
  const { directory, teamDirectory, teams, members, memberTeams, audit } = dependencies;

  const assertStaff = (staff: PlanStaff) => {
    if (!isPlanStaff(staff)) throw new StaffAccessError("STAFF_ACCESS_FORBIDDEN", "Only RFPilot staff can do that.", 403);
    if (!staff.adminId || !staff.organizationId) throw new StaffAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  };

  // Every event of this service. Its organization is always the staff member's own; the
  // customer organization, the team and the member appear only as the target and in the metadata.
  const eventOf = (attempt: Attempt, reason: string, metadata: Record<string, unknown>): MemberChangeAudit => ({
    organizationId: attempt.staff.organizationId,
    actorUserId: attempt.staff.adminId,
    action: attempt.action,
    targetType: attempt.targetType,
    targetId: attempt.targetType === "team" ? attempt.teamId : attempt.memberUserId,
    reason,
    correlationId: attempt.staff.correlationId,
    metadata: {
      agentAccountType: "admin",
      organizationId: attempt.organizationId,
      ...(attempt.teamId ? { teamId: attempt.teamId } : {}),
      ...(attempt.memberUserId ? { memberUserId: attempt.memberUserId } : {}),
      ...(attempt.staffReason ? { staffReason: attempt.staffReason } : {}),
      ...metadata,
    },
  });

  // A request that changed nothing (a read, or a team someone else archived meanwhile). Awaited
  // before anything is returned: if it can't be written the request fails.
  const recordAllowed = (attempt: Attempt, reason: string, metadata: Record<string, unknown>) =>
    audit.append({ ...eventOf(attempt, reason, metadata), decision: "allowed" });

  // A refusal: nothing was changed, so the answer is returned whether or not this can be written.
  const recordDenied = async (attempt: Attempt, error: StaffMemberError) => {
    try {
      const { targetId, ...event } = eventOf(attempt, error.code.toLowerCase(), error.status === 400 ? {} : { ...error.details });
      await audit.append({ ...event, ...(ID.test(targetId) ? { targetId } : {}), decision: "denied" });
    } catch (failure) {
      console.error("Staff team management error: a refused request could not be recorded:", failure instanceof Error ? failure.message : failure);
    }
  };

  const attempt = async <T>(
    staff: PlanStaff,
    action: string,
    where: { organizationId: unknown; teamId?: unknown; memberUserId?: unknown; targetType?: Attempt["targetType"] },
    work: (attempt: Attempt) => Promise<T>,
  ): Promise<T> => {
    assertStaff(staff);
    const current: Attempt = {
      staff, action, targetType: where.targetType ?? "team",
      organizationId: asTyped(where.organizationId), teamId: asTyped(where.teamId), memberUserId: asTyped(where.memberUserId), staffReason: null,
    };
    try {
      return await work(current);
    } catch (error) {
      // A refusal of the team service is the customer's refusal: same code, status and message.
      const refusal = error instanceof TeamError ? refused(error.status, error.code, error.message) : error;
      if (refusal instanceof StaffMemberError) await recordDenied(current, refusal);
      throw refusal;
    }
  };

  // Ids first (nothing is looked up for a malformed one), then the reason every write carries.
  const validate = (current: Attempt, input: { reason?: unknown } | null, ids: { team?: boolean; member?: boolean }) => {
    if (!ID.test(current.organizationId)) throw refused(400, "INVALID_ORGANIZATION_ID", "That is not an organization id.");
    if (ids.team && !ID.test(current.teamId)) throw refused(400, "INVALID_TEAM_ID", "That is not a team id.");
    if (ids.member && !ID.test(current.memberUserId)) throw refused(400, "INVALID_MEMBER_ID", "That is not a member id.");
    if (input) current.staffReason = parseReason(input.reason);
  };

  // The organization in the path: it must exist, be a customer organization, and not be RFPilot's.
  const organizationOf = async (current: Attempt): Promise<string> => {
    const organization = await directory.organization(current.organizationId);
    if (!organization) throw refused(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
    const standing = unmanageableStanding(organization, current.staff.organizationId);
    if (standing === "platform") {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "Teams of RFPilot's own organization can't be managed here.", { standing });
    }
    if (standing) {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "This organization is awaiting placement. Its teams can't be managed yet.", { standing });
    }
    return organization.id;
  };

  /* The staff actor the team service is given: the path's organization, and how the one event of
     this request is made. The service names the kind of change it commits; it must be the one
     this request was recorded under. The team and member in the event are the validated ones of
     the request, not anything the service passes back. */
  const actorOf = (current: Attempt, organizationId: string, kind: TeamChangeKind): StaffTeamActor => {
    const same = (committed: TeamChangeKind) => {
      if (committed !== kind) throw new Error("The team change is not the one that was asked for.");
    };
    return staffTeamActor({
      organizationId,
      committed: (committed, _target, metadata) => {
        same(committed);
        return eventOf(current, `team_${kind}`, metadata);
      },
      unchanged: async (committed, _target, metadata) => {
        same(committed);
        await recordAllowed(current, `team_${kind}_unchanged`, metadata);
      },
    });
  };

  // The team read back through the staff allowlists, in the path's organization.
  const answer = async (organizationId: string, teamId: string) => {
    const found = await teamDirectory.team(organizationId, teamId);
    if (!found) throw new Error("The team could not be read back.");
    return { organizationId, ...teamDetailView(found) };
  };

  // One team change: validated, in the path's organization, through the customer's team service.
  const change = (
    staff: PlanStaff,
    kind: TeamChangeKind,
    where: { organizationId: unknown; teamId?: unknown; memberUserId?: unknown },
    input: { reason?: unknown },
    ids: { team?: boolean; member?: boolean },
    run: (actor: StaffTeamActor, current: Attempt) => Promise<{ id: string }>,
    check?: (current: Attempt) => void,
  ) =>
    attempt(staff, ACTION[kind], where, async (current) => {
      validate(current, input, ids);
      check?.(current);
      const organization = await organizationOf(current);
      const team = await run(actorOf(current, organization, kind), current);
      return answer(organization, team.id);
    });

  return {
    /** One team with its members: current data, and each member's version for a change of their teams. */
    team: (staff: PlanStaff, organizationId: string, teamId: string) =>
      attempt(staff, STAFF_TEAM_AUDIT.read, { organizationId, teamId }, async (current) => {
        validate(current, null, { team: true });
        const organization = await organizationOf(current);
        const found = await teamDirectory.team(organization, current.teamId);
        if (!found) throw teamNotFound();
        await recordAllowed(current, "team", { resource: "team" });
        return { organizationId: organization, ...teamDetailView(found) };
      }),

    create: (staff: PlanStaff, organizationId: string, input: { name?: unknown; reason?: unknown }) =>
      change(staff, "created", { organizationId }, input, {}, (actor) => teams.create(actor, { name: input.name })),

    rename: (staff: PlanStaff, organizationId: string, teamId: string, input: { name?: unknown; reason?: unknown }) =>
      change(staff, "renamed", { organizationId, teamId }, input, { team: true }, (actor, current) => teams.rename(actor, current.teamId, { name: input.name })),

    /* The team stops being active: it can't be renamed or have its members changed, it is no
       longer offered for a proposal, and its managers lose their scope over its proposals on
       their next request. Its memberships are kept, and NO proposal is changed: a proposal on
       the team keeps its `teamId`. This is the customer's archive, exactly. */
    archive: (staff: PlanStaff, organizationId: string, teamId: string, input: { reason?: unknown }) =>
      change(staff, "archived", { organizationId, teamId }, input, { team: true }, (actor, current) => teams.archive(actor, current.teamId)),

    addMember: (staff: PlanStaff, organizationId: string, teamId: string, input: { userId?: unknown; isManager?: unknown; reason?: unknown }) =>
      change(staff, "member_added", { organizationId, teamId, memberUserId: input.userId }, input, { team: true },
        (actor, current) => teams.addMember(actor, current.teamId, { userId: current.memberUserId, isManager: input.isManager }),
        // The customer's answer for a member id that can't be one, given before anything is looked up.
        (current) => {
          if (!ID.test(current.memberUserId)) throw refused(404, "MEMBER_NOT_FOUND", "Member not found in this organization.");
        }),

    removeMember: (staff: PlanStaff, organizationId: string, teamId: string, userId: string, input: { reason?: unknown }) =>
      change(staff, "member_removed", { organizationId, teamId, memberUserId: userId }, input, { team: true, member: true },
        (actor, current) => teams.removeMember(actor, current.teamId, current.memberUserId)),

    setManager: (staff: PlanStaff, organizationId: string, teamId: string, userId: string, input: { isManager?: unknown; reason?: unknown }) =>
      change(staff, "manager_changed", { organizationId, teamId, memberUserId: userId }, input, { team: true, member: true },
        (actor, current) => teams.setManager(actor, current.teamId, current.memberUserId, { isManager: input.isManager })),

    /* The member's active teams become exactly `teamIds` (manager flags are kept on teams the
       member stays on; a team the member joins is joined as a plain member). `version` is the
       member's current membership version. The version, the team rows and the staff-side event
       commit in one transaction. */
    setMemberTeams: (staff: PlanStaff, organizationId: string, userId: string, input: { teamIds?: unknown; version?: unknown; reason?: unknown }) =>
      attempt(staff, STAFF_TEAM_AUDIT.memberTeamsChanged, { organizationId, memberUserId: userId, targetType: "organization_membership" }, async (current) => {
        validate(current, input, { member: true });
        const selection = parseTeamSelection(input.teamIds);
        if (!selection.ok) throw fromRefusal(selection);
        // Ids on the staff routes are lower-case hex, here as everywhere else.
        if (!selection.teamIds.every((id) => ID.test(id))) throw fromRefusal(invalidTeams());
        const { teamIds } = selection;
        const version = versionOf(input.version);
        const organization = await organizationOf(current);
        const target = await members.find(organization, current.memberUserId);
        if (!target) throw memberNotFound();
        if (target.version !== version) throw stale(target);
        allow(decideTeamsChange({ target }));
        // Both checked in the path's organization: another organization's team is unknown.
        const known = await memberTeams.activeTeamIds(organization, teamIds);
        if (known === "unavailable") throw fromRefusal(teamsUnavailable());
        const unknown = teamIds.filter((id) => !known.includes(id));
        if (unknown.length > 0) throw fromRefusal(unknownTeams(unknown));
        const result = await memberTeams.setMemberTeams({
          organizationId: organization, userId: target.userId, teamIds, expectedVersion: version,
          // The store adds `before.teamIds`, `changed` and the new `version` inside the transaction.
          audit: eventOf(current, "teams_changed", { after: { teamIds: [...teamIds].sort() } }),
        });
        if (result === "stale") throw stale(await members.find(organization, target.userId));
        // A team archived between the check and the write: nothing was applied, not even the version.
        if ("unknownTeamIds" in result) throw fromRefusal(unknownTeams(result.unknownTeamIds));
        const found = await directory.member(organization, target.userId);
        if (!found) throw new Error("The member could not be read back.");
        const changed = result.previousTeamIds.length !== teamIds.length || result.previousTeamIds.some((id) => !teamIds.includes(id));
        return { organizationId: organization, changed, member: staffMemberView(found.member), version: found.version };
      }),
  };
};

export type StaffTeamManagement = ReturnType<typeof createStaffTeamManagement>;
