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

// Optimistic writes take the version the caller last read and return "stale" when it moved.
export interface MembershipStore {
  list(organizationId: string): Promise<MemberRecord[]>;
  find(organizationId: string, userId: string): Promise<MemberRecord | null>;
  countOwnedRfps(organizationId: string, userId: string): Promise<number>;
  setRoles(input: { organizationId: string; userId: string; expectedVersion: number; roles: string[] }): Promise<MemberRecord | "stale">;
  // Refuses with owns_rfps when the member owns an RFP when the change commits.
  deactivate(input: { organizationId: string; userId: string; expectedVersion: number; now: Date }): Promise<MemberRecord | "stale" | { ownedRfpCount: number }>;
  reactivate(input: { organizationId: string; userId: string; expectedVersion: number }): Promise<MemberRecord | "stale">;
  // Bumps the version for a change stored elsewhere (team memberships).
  bumpVersion(input: { organizationId: string; userId: string; expectedVersion: number }): Promise<MemberRecord | "stale">;
  // One transaction: the current Owner becomes organization_admin and the target becomes Owner.
  // not_owner when the actor is no longer the active Owner when it commits.
  transferOwnership(input: {
    organizationId: string; fromUserId: string; toUserId: string; expectedTargetVersion: number;
  }): Promise<{ from: MemberRecord; to: MemberRecord } | "stale" | "not_owner">;
}

// ORG-207: moves RFPs owned by one member to another in one transaction. rfpIds null = all.
export interface RfpReassignmentStore {
  reassign(input: {
    organizationId: string; fromUserId: string; toUserId: string; rfpIds: string[] | null;
  }): Promise<{ rfpIds: string[] } | "target_ineligible" | { notOwnedCount: number }>;
}
// Mirrors the new owner into secondary stores (the Postgres proposal reference). Best effort:
// MongoDB is authoritative and reconciliation repairs a failed write.
export interface RfpOwnershipMirror {
  afterReassign(input: { organizationId: string; rfpIds: string[]; toUserId: string }): Promise<void>;
}

// ORG-307: what a membership change does to the member's sessions.
export type SessionChange = { organizationId: string; userId: string; actorUserId: string; actorSessionId?: string; correlationId: string };
export interface MemberSessionHooks {
  afterRoleChange(change: SessionChange): Promise<unknown>;
  afterDeactivation(change: SessionChange): Promise<unknown>;
}

// Teams arrive with ORG-201. Until then nobody is on a team and team changes are unavailable.
export interface TeamDirectory {
  teamsFor(organizationId: string, userIds: string[]): Promise<Map<string, TeamRef[]>>;
  // Which of teamIds are active teams of the organization; "unavailable" before ORG-201.
  activeTeamIds(organizationId: string, teamIds: string[]): Promise<string[] | "unavailable">;
  // Makes the member's active teams exactly teamIds, keeping manager flags on teams they stay on.
  setMemberTeams(input: { organizationId: string; userId: string; teamIds: string[] }): Promise<{ previousTeamIds: string[] }>;
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
