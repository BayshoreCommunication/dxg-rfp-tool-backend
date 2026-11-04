import type { RfpActor, SharePermission } from "../domain/rfpAccessPolicy";

export type ActorLookups = {
  // Ids of active (non-archived) teams the user manages in the organization.
  managedTeamIds(input: { organizationId: string; userId: string }): Promise<string[]>;
  // Proposals shared with the user in the organization, keyed by proposal id.
  shares(input: { organizationId: string; userId: string }): Promise<Map<string, SharePermission>>;
};

// For callers and tests that need an actor reaching only what the role and ownership allow.
export const noTeamsOrShares: ActorLookups = {
  managedTeamIds: async () => [],
  shares: async () => new Map(),
};

// Built once per authenticated request from the membership the auth middleware already loaded.
export const resolveRfpActor = async (
  membership: { organizationId: string; userId: string; roles: readonly string[]; status: string },
  lookups: ActorLookups,
): Promise<RfpActor> => {
  const scope = { organizationId: membership.organizationId, userId: membership.userId };
  const active = membership.status === "active";
  const [managedTeamIds, shares] = active
    ? await Promise.all([lookups.managedTeamIds(scope), lookups.shares(scope)])
    : [[], new Map<string, SharePermission>()];
  return { ...scope, roles: [...membership.roles], membershipStatus: membership.status, managedTeamIds, shares };
};
