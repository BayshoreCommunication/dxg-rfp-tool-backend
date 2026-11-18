import type { MemberStatus } from "./memberPolicy";

export type MemberRecord = {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string | null;
  roles: string[];
  status: MemberStatus;
  version: number;
  lastSignedInAt: Date | null;
  createdAt: Date | null;
};

export type TeamRef = { id: string; name: string };

/* An audit event a write commits together with the change (RFPilot staff changes; owner decision
   2026-11-18). When a write is given one, the event is inserted in the SAME transaction as the
   change, so the change is never applied without its record and never recorded without being
   applied. `organizationId` is the organization whose audit trail receives the event: for a staff
   change that is the STAFF organization, never the member's own. */
export type MemberChangeAudit = {
  organizationId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  metadata: Record<string, unknown>;
};

// Optimistic writes take the version the caller last read and return "stale" when it moved.
export interface MembershipStore {
  list(organizationId: string): Promise<MemberRecord[]>;
  find(organizationId: string, userId: string): Promise<MemberRecord | null>;
  countOwnedRfps(organizationId: string, userId: string): Promise<number>;
  // When the new roles can't own RFPs, refuses with ownedRfpCount if the member owns one when
  // the change commits.
  setRoles(input: { organizationId: string; userId: string; expectedVersion: number; roles: string[]; audit?: MemberChangeAudit }): Promise<MemberRecord | "stale" | { ownedRfpCount: number }>;
  // Refuses with owns_rfps when the member owns an RFP when the change commits. `reverted` marks
  // the rare refusal that came after the commit (an RFP created while it committed): the member
  // was put back. An `audit` event given with the change was already written by then, so the
  // put-back and `revertAudit` (with `ownedRfpCount` added) commit together in one transaction:
  // the trail never says "deactivated" for a member who is active without saying it was undone.
  // A deactivation given an `audit` event is a staff one and is marked as such on the membership.
  deactivate(input: { organizationId: string; userId: string; expectedVersion: number; now: Date; audit?: MemberChangeAudit; revertAudit?: MemberChangeAudit }): Promise<MemberRecord | "stale" | { ownedRfpCount: number; reverted?: boolean }>;
  reactivate(input: { organizationId: string; userId: string; expectedVersion: number; audit?: MemberChangeAudit }): Promise<MemberRecord | "stale">;
  // Bumps the version for a change stored elsewhere (team memberships).
  bumpVersion(input: { organizationId: string; userId: string; expectedVersion: number }): Promise<MemberRecord | "stale">;
  // One transaction: the current Owner becomes organization_admin and the target becomes Owner.
  // not_owner when the actor is no longer the active Owner when it commits.
  transferOwnership(input: {
    organizationId: string; fromUserId: string; toUserId: string; expectedTargetVersion: number; audit?: MemberChangeAudit;
  }): Promise<{ from: MemberRecord; to: MemberRecord } | "stale" | "not_owner">;
  // The organization's one active Owner, for a transfer started by someone who is not the Owner
  // (RFPilot staff). Null when there is none.
  activeOwner(organizationId: string): Promise<MemberRecord | null>;
}

// ORG-207: moves RFPs owned by one member to another in one transaction. rfpIds null = all.
export interface RfpReassignmentStore {
  // `audit`, when given, is written in the same transaction with `reassignedCount` and the moved
  // `rfpIds` (the first 1,000) added to its metadata. Nothing is written when nothing is moved
  // because the target is ineligible or a selected RFP isn't the member's.
  reassign(input: {
    organizationId: string; fromUserId: string; toUserId: string; rfpIds: string[] | null; audit?: MemberChangeAudit;
  }): Promise<{ rfpIds: string[] } | "target_ineligible" | { notOwnedCount: number }>;
}
// Mirrors the new owner into secondary stores (the Postgres proposal reference). Best effort:
// MongoDB is authoritative and reconciliation repairs a failed write.
export interface RfpOwnershipMirror {
  afterReassign(input: { organizationId: string; rfpIds: string[]; toUserId: string }): Promise<void>;
}

// ORG-307: what a membership change does to the member's sessions.
// `staffOrganizationId` is given only by RFPilot staff member management (the organization that records it).
export type SessionChange = { organizationId: string; userId: string; actorUserId: string; actorSessionId?: string; correlationId: string; demoted?: boolean; staffOrganizationId?: string };
export interface MemberSessionHooks {
  afterRoleChange(change: SessionChange): Promise<unknown>;
  afterDeactivation(change: SessionChange): Promise<unknown>;
}

// The member's teams (ORG-201). "unavailable" when no team store is configured.
export interface TeamDirectory {
  // Active teams only.
  teamsFor(organizationId: string, userIds: string[]): Promise<Map<string, TeamRef[]>>;
  // Which of teamIds are active teams of the organization.
  activeTeamIds(organizationId: string, teamIds: string[]): Promise<string[] | "unavailable">;
  // Makes the member's active teams exactly teamIds, keeping manager flags on teams they stay on.
  // Returns unknownTeamIds, and changes nothing, when a team stopped being active meanwhile.
  setMemberTeams(input: { organizationId: string; userId: string; teamIds: string[] }): Promise<{ previousTeamIds: string[] } | { unknownTeamIds: string[] }>;
}

/* "Change a member's teams" by RFPilot staff (owner decision 2026-11-18): what `bumpVersion` and
   `setMemberTeams` do for a member of the organization, in ONE transaction together with the
   staff-side `audit` event, so nothing is applied without its record (not even the version).
   The store adds `before.teamIds`, `changed` and the new `version` to the event's metadata.
   "stale" when the membership's version moved or the member is removed; `unknownTeamIds`, and
   nothing changed, when a team stopped being active meanwhile. */
export interface StaffMemberTeamsStore {
  setMemberTeams(input: {
    organizationId: string; userId: string; teamIds: string[]; expectedVersion: number; audit: MemberChangeAudit;
  }): Promise<{ previousTeamIds: string[]; version: number } | { unknownTeamIds: string[] } | "stale">;
}

export interface MemberAuditWriter {
  append(input: {
    organizationId?: string;
    actorUserId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    decision: "allowed" | "denied" | "created" | "revoked" | "detected";
    reason: string;
    correlationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}
