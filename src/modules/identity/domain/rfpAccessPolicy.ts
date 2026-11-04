import { Types } from "mongoose";

// Single authority for proposal (RFP) visibility: the per-proposal decision and the list
// filter are both derived from relationshipGrants, so a list can never show a proposal the
// detail route would refuse. Rules follow the source permissions matrix (spec §4, §7).

export const RFP_ACTIONS = ["view", "edit", "viewResponses", "reassign", "archive", "delete", "share", "grantSupport"] as const;
export type RfpAction = (typeof RFP_ACTIONS)[number];
export type SharePermission = "view" | "edit";

type Id = string | Types.ObjectId;

export interface RfpActor {
  organizationId: Id;
  userId: Id;
  roles: readonly string[];
  membershipStatus: string;
  // Teams the actor manages. ORG-103 resolves these from active (non-archived) teams only,
  // so archiving a team removes its manager's visibility.
  managedTeamIds: readonly Id[];
  // Proposals shared with the actor, keyed by proposal id.
  shares: ReadonlyMap<string, SharePermission>;
}

export interface RfpRef {
  id: Id;
  organizationId?: Id | null;
  ownerUserId?: Id | null;
  teamId?: Id | null;
}

export type RfpAccessDecision = { allowed: true } | { allowed: false; reason: "not_found" | "forbidden" };

const ORGANIZATION_WIDE: readonly RfpAction[] = RFP_ACTIONS;
const TEAM_MANAGER: readonly RfpAction[] = ["view", "edit", "viewResponses", "reassign", "archive", "delete", "share"];
const PROPOSAL_OWNER: readonly RfpAction[] = ["view", "edit", "viewResponses", "archive", "delete", "share"];
const EDIT_SHARE: readonly RfpAction[] = ["view", "edit", "viewResponses"];
const VIEW_SHARE: readonly RfpAction[] = ["view", "viewResponses"];

const ORGANIZATION_WIDE_ROLES = ["owner", "organization_admin"];
const PROPOSAL_CREATOR_ROLES = ["owner", "organization_admin", "team_manager", "planner"];
const EDIT_SHARE_ROLES = ["owner", "organization_admin", "team_manager", "planner"];

const toId = (value: Id | null | undefined): string | null => (value == null ? null : String(value));
const hasAnyRole = (actor: RfpActor, roles: readonly string[]) => actor.roles.some((role) => roles.includes(role));
const isActive = (actor: RfpActor) => actor.membershipStatus === "active";

// Viewers only ever receive view rights, whatever the share says.
const shareGrants = (actor: RfpActor, permission: SharePermission | undefined): readonly RfpAction[] => {
  if (!permission || !hasAnyRole(actor, [...EDIT_SHARE_ROLES, "viewer"])) return [];
  return permission === "edit" && hasAnyRole(actor, EDIT_SHARE_ROLES) ? EDIT_SHARE : VIEW_SHARE;
};

const relationshipGrants = (actor: RfpActor) => ({
  organizationWide: hasAnyRole(actor, ORGANIZATION_WIDE_ROLES) ? ORGANIZATION_WIDE : [],
  owner: hasAnyRole(actor, PROPOSAL_CREATOR_ROLES) ? PROPOSAL_OWNER : [],
  teamManager: actor.roles.includes("team_manager") ? TEAM_MANAGER : [],
});

export const canAccessRfp = (actor: RfpActor, rfp: RfpRef, action: RfpAction): RfpAccessDecision => {
  // Another organization's proposal is reported as missing so its existence never leaks.
  if (toId(rfp.organizationId) !== toId(actor.organizationId)) return { allowed: false, reason: "not_found" };
  if (!isActive(actor)) return { allowed: false, reason: "forbidden" };

  const grants = relationshipGrants(actor);
  const teamId = toId(rfp.teamId);
  const allowed =
    grants.organizationWide.includes(action) ||
    (toId(rfp.ownerUserId) === toId(actor.userId) && grants.owner.includes(action)) ||
    (teamId !== null && actor.managedTeamIds.some((id) => toId(id) === teamId) && grants.teamManager.includes(action)) ||
    shareGrants(actor, actor.shares.get(toId(rfp.id) as string)).includes(action);
  return allowed ? { allowed: true } : { allowed: false, reason: "forbidden" };
};

const MATCH_NOTHING = { $in: [] as Types.ObjectId[] };
const objectId = (value: Id) => new Types.ObjectId(String(value));

// Mongo filter over the Proposal collection selecting exactly the proposals for which
// canAccessRfp(actor, proposal, action) allows. Field names match modal/proposalsModel.ts
// (userId is the owner); teamId arrives with ORG-2xx and is optional until then.
export const rfpListScope = (actor: RfpActor, action: RfpAction = "view"): Record<string, unknown> => {
  const organizationId = objectId(actor.organizationId);
  if (!isActive(actor)) return { organizationId, _id: MATCH_NOTHING };

  const grants = relationshipGrants(actor);
  if (grants.organizationWide.includes(action)) return { organizationId };

  const clauses: Record<string, unknown>[] = [];
  if (grants.owner.includes(action)) clauses.push({ userId: objectId(actor.userId) });
  if (grants.teamManager.includes(action) && actor.managedTeamIds.length > 0) {
    clauses.push({ teamId: { $in: actor.managedTeamIds.map(objectId) } });
  }
  const sharedIds = [...actor.shares]
    .filter(([, permission]) => shareGrants(actor, permission).includes(action))
    .map(([id]) => objectId(id));
  if (sharedIds.length > 0) clauses.push({ _id: { $in: sharedIds } });

  return clauses.length > 0 ? { organizationId, $or: clauses } : { organizationId, _id: MATCH_NOTHING };
};
