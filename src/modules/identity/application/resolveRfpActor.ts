import type { RfpActor, SharePermission } from "../domain/rfpAccessPolicy";

export type ActorLookups = {
  // Ids of active (non-archived) teams the user manages in the organization.
  managedTeamIds(input: { organizationId: string; userId: string }): Promise<string[]>;
  // Proposals shared with the user in the organization, keyed by proposal id.
  shares(input: { organizationId: string; userId: string }): Promise<Map<string, SharePermission>>;
};

// Team, TeamMembership and ProposalShare arrive in M2 (ORG-2xx). Until then nobody manages a
// team and nothing is shared, so the actor reaches only what the role and ownership allow.
export const noTeamsOrSharesYet: ActorLookups = {
  managedTeamIds: async () => [],
  shares: async () => new Map(),
};

// Built once per authenticated request from the membership the auth middleware already loaded.
export const resolveRfpActor = async (
  membership: { organizationId: string; userId: string; roles: readonly string[]; status: string },
  lookups: ActorLookups = noTeamsOrSharesYet,
): Promise<RfpActor> => {
  const scope = { organizationId: membership.organizationId, userId: membership.userId };
  const active = membership.status === "active";
  const [managedTeamIds, shares] = active
    ? await Promise.all([lookups.managedTeamIds(scope), lookups.shares(scope)])
    : [[], new Map<string, SharePermission>()];
  return { ...scope, roles: [...membership.roles], membershipStatus: membership.status, managedTeamIds, shares };
};
