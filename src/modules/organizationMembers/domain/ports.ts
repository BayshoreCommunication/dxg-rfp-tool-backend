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
  // One transaction: the current Owner becomes organization_admin and the target becomes Owner.
  // not_owner when the actor is no longer the active Owner when it commits.
  transferOwnership(input: {
    organizationId: string; fromUserId: string; toUserId: string; expectedTargetVersion: number;
  }): Promise<{ from: MemberRecord; to: MemberRecord } | "stale" | "not_owner">;
}

// Teams arrive with ORG-201. Until then nobody is on a team.
export interface TeamDirectory {
  teamsFor(organizationId: string, userIds: string[]): Promise<Map<string, TeamRef[]>>;
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
