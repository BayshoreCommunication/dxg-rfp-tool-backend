import type { RfpActor, RfpRef, SharePermission } from "../identity/domain/rfpAccessPolicy";

export class ShareError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ShareError";
  }
}

export type ShareActor = { rfpActor: RfpActor; correlationId: string };

export type ShareRecord = { userId: string; permission: SharePermission; grantedBy: string; createdAt: Date; updatedAt: Date };
// memberActive is false for a deactivated member: the share is kept but grants nothing.
export type ShareView = ShareRecord & { memberActive: boolean };

export interface ShareRepository {
  list(organizationId: string, proposalId: string): Promise<ShareRecord[]>;
  // Returns the permission held before the write, or null for a new share.
  upsert(input: { organizationId: string; proposalId: string; userId: string; permission: SharePermission; grantedBy: string }): Promise<SharePermission | null>;
  // Returns the permission that was removed, or null when there was no share.
  remove(input: { organizationId: string; proposalId: string; userId: string }): Promise<SharePermission | null>;
}

export interface SharedProposalLookup {
  // The proposal in the organization, or null.
  find(organizationId: string, proposalId: string): Promise<RfpRef | null>;
}

export interface ShareMemberDirectory {
  find(organizationId: string, userIds: readonly string[]): Promise<Map<string, { roles: readonly string[]; status: string }>>;
}
