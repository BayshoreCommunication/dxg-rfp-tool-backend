export class TeamError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "TeamError";
  }
}

export type TeamActor = { organizationId: string; userId: string; roles: readonly string[]; correlationId: string };

/* An audit event a team write commits together with the change (RFPilot staff changes; owner
   decision 2026-11-18, docs/DECISIONS.md). When a write is given one, the event is inserted in
   the SAME transaction as the change: the change is never applied without its record and never
   recorded without being applied. `organizationId` is the organization whose audit trail
   receives the event: for a staff change that is the STAFF organization, never the team's own. */
export type TeamChangeAudit = {
  organizationId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  metadata: Record<string, unknown>;
};

// The changes of this module: the suffix of the member's `team.<kind>` event.
export type TeamChangeKind = "created" | "renamed" | "archived" | "member_added" | "member_removed" | "manager_changed";
export type TeamChangeTarget = { teamId: string | null; userId?: string };

/* RFPilot staff managing a customer organization's teams (owner decision, 2026-11-18). Staff are
   not members: they have no user id and no role in the organization, so they are never compared
   with a member, never treated as its Owner or Admin, and never written into it. The staff guard
   (an `admins` account with an admin role) is checked before this actor is made.

   `organizationId` is the customer organization, from the request's path. `committed` builds the
   staff-side event a write commits in its own transaction; `unchanged` records a request that
   found nothing to change. The member events (`team.*`) are not written for this actor. */
export type StaffTeamActor = {
  readonly staff: true;
  readonly organizationId: string;
  committed(kind: TeamChangeKind, target: TeamChangeTarget, metadata: Record<string, unknown>): TeamChangeAudit;
  unchanged(kind: TeamChangeKind, target: TeamChangeTarget, metadata: Record<string, unknown>): Promise<void>;
};
export type TeamManager = TeamActor | StaffTeamActor;

// Only an actor made by `staffTeamActor` is one: an object that merely carries `staff: true`
// (a request body, a session, a member actor with an extra field) is not.
const staffTeamActors = new WeakSet<object>();
/* CAPABILITY: the ONLY caller allowed is
   src/modules/staffAccess/application/manageOrganizationTeams.ts. Do not call this from anywhere else.

   Why: an actor made here skips the Owner/Admin role check of the team rules (`requireManager`
   in application/manageTeams.ts) for whatever `organizationId` it is given, and makes the store
   take its staff branch. Nothing in this function checks who is asking: the staff guard (an
   `admins` account with an admin role), the request validation and the "is this a customer
   organization" check all run in manageOrganizationTeams.ts BEFORE it makes the actor, and its
   `committed` / `unchanged` are what put the audit event in the STAFF organization. A second
   caller would be a way to change any organization's teams without those checks or that record.

   It is exported only because the staff service lives in another module. The language does not
   enforce the rule: tests/staff-team-management.test.js walks the source tree and fails if any
   other file names this function. Keep that test when changing this. */
export const staffTeamActor = (input: Omit<StaffTeamActor, "staff">): StaffTeamActor => {
  const actor: StaffTeamActor = Object.freeze({ staff: true as const, organizationId: input.organizationId, committed: input.committed, unchanged: input.unchanged });
  staffTeamActors.add(actor);
  return actor;
};
export const isStaffTeamActor = (actor: TeamManager): actor is StaffTeamActor =>
  typeof actor === "object" && actor !== null && staffTeamActors.has(actor);

export type TeamRecord = { id: string; name: string; archived: boolean; archivedAt: Date | null; createdAt: Date };
export type TeamMemberRecord = { teamId: string; userId: string; isManager: boolean };

/* Why a STAFF write (one given an `audit` event) was not applied. The team rules check the team
   and the member before they call the store; the store checks them again inside the transaction
   of the write, so a team archived, or a member deactivated or demoted, in between is refused
   there with nothing applied and no event. A write without an event never returns one. */
export type TeamWriteRefusal = "team_not_found" | "team_archived" | "member_not_found" | "manager_role_required";

export type TeamView = TeamRecord & { members: { userId: string; isManager: boolean }[] };
export type TeamSummary = Pick<TeamRecord, "id" | "name">;

/* Every write takes an optional `audit` event (a staff change). Given one, the write and the
   event commit in one transaction, and the store adds to the event's metadata what only the
   transaction knows: the new team's id (`create`, also its `targetId`), and the value it replaced
   as `before` with `changed` (`rename`, `removeMember`, `setManager`). Without one a write does
   exactly what it did before the staff routes existed. */
export interface TeamRepository {
  list(organizationId: string): Promise<TeamRecord[]>;
  findById(organizationId: string, teamId: string): Promise<TeamRecord | null>;
  // "duplicate" when an active team in the organization already has the name (case-insensitive).
  create(input: { organizationId: string; name: string; createdBy: string | null; audit?: TeamChangeAudit }): Promise<TeamRecord | "duplicate">;
  rename(input: { organizationId: string; teamId: string; name: string; audit?: TeamChangeAudit }): Promise<TeamRecord | "duplicate" | null>;
  // False when the team is missing or already archived.
  archive(input: { organizationId: string; teamId: string; at: Date; audit?: TeamChangeAudit }): Promise<boolean>;
  members(organizationId: string, teamIds: readonly string[]): Promise<TeamMemberRecord[]>;
  // With an event: the team must be an active team of the organization and the user an active
  // member of it (holding the Team Manager role when `isManager`), checked in the transaction.
  addMember(input: { organizationId: string; teamId: string; userId: string; isManager: boolean; audit?: TeamChangeAudit }): Promise<"added" | "exists" | TeamWriteRefusal>;
  removeMember(input: { organizationId: string; teamId: string; userId: string; audit?: TeamChangeAudit }): Promise<boolean>;
  // False when the user is not on the team. With an event: the team must be an active team of the
  // organization, and to set a manager the user an active member holding the Team Manager role.
  setManager(input: { organizationId: string; teamId: string; userId: string; isManager: boolean; audit?: TeamChangeAudit }): Promise<boolean | TeamWriteRefusal>;
}

export interface OrganizationMemberDirectory {
  find(organizationId: string, userId: string): Promise<{ roles: readonly string[]; status: string } | null>;
}
