// ORG-206: who may change whom. Pure decisions; the use cases load the facts and apply them.
// Exactly one active Owner per organization: `owner` is never granted or removed by a role
// change, only moved by an ownership transfer, and the Owner can't be deactivated.

export const ASSIGNABLE_ROLES = ["organization_admin", "team_manager", "planner", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
const CUSTOMER_ROLES = ["owner", ...ASSIGNABLE_ROLES] as const;
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];
// Kept across a role change: knowledge roles are granted separately from the customer role.
const KEPT_ROLES = ["knowledge_editor", "knowledge_approver"];

export type MemberStatus = "invited" | "active" | "suspended" | "removed";

export type MemberFacts = { userId: string; roles: readonly string[]; status: MemberStatus };
export type ManagerFacts = { userId: string; roles: readonly string[] };

export type Refusal = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 503;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
export type Decision = { ok: true } | Refusal;

const allow: Decision = { ok: true };
const refuse = (status: Refusal["status"], code: string, message: string, details?: Record<string, unknown>): Refusal =>
  ({ ok: false, status, code, message, ...(details ? { details } : {}) });

export const isOwner = (roles: readonly string[]) => roles.includes("owner");
export const canManageMembers = (roles: readonly string[]) => roles.includes("owner") || roles.includes("organization_admin");
export const isAssignableRole = (value: unknown): value is AssignableRole =>
  typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value);

// The single customer role a membership carries (legacy memberships may hold several).
export const customerRole = (roles: readonly string[]): CustomerRole | null =>
  CUSTOMER_ROLES.find((role) => roles.includes(role)) ?? null;

// A role change that leaves the member with less (ORG-307 ends their sessions at once).
// Roles outside the customer ranking count as lost when they're removed.
export const isDemotion = (previous: readonly string[], next: readonly string[]) => {
  const rank = (roles: readonly string[]) => {
    const role = customerRole(roles);
    return role ? CUSTOMER_ROLES.indexOf(role) : CUSTOMER_ROLES.length;
  };
  if (rank(next) > rank(previous)) return true;
  return previous.some((role) => !(CUSTOMER_ROLES as readonly string[]).includes(role) && !next.includes(role));
};

// The roles a membership ends up with when its customer role becomes `role`.
export const withCustomerRole = (roles: readonly string[], role: CustomerRole): string[] =>
  [role, ...roles.filter((r) => KEPT_ROLES.includes(r))];

const ownerOnly = () => refuse(403, "OWNER_ONLY", "Only the organization's Owner can change the Owner role.");
const lastOwner = () =>
  refuse(409, "LAST_OWNER", "The Owner can't be demoted or deactivated. Transfer ownership to another member first.");
export const ownerHasRfps = (count: number) =>
  refuse(409, "OWNER_HAS_RFPS", `This member still owns ${count} RFP${count === 1 ? "" : "s"}. Reassign them first.`, { ownedRfpCount: count });

export const decideManage = (actor: ManagerFacts): Decision =>
  canManageMembers(actor.roles) ? allow : refuse(403, "FORBIDDEN", "Only Owners and Admins can manage members.");

export const decideRoleChange = (input: {
  actor: ManagerFacts;
  target: MemberFacts;
  role: CustomerRole;
  ownedRfpCount: number;
}): Decision => {
  const { actor, target, role } = input;
  if (target.status === "removed") return refuse(409, "MEMBER_REMOVED", "This member has been removed.");
  const touchesOwner = role === "owner" || isOwner(target.roles);
  if (touchesOwner) {
    if (!isOwner(actor.roles)) return ownerOnly();
    if (target.userId === actor.userId) return role === "owner" ? allow : lastOwner();
    return refuse(409, "OWNERSHIP_TRANSFER_REQUIRED", "Use ownership transfer to make another member the Owner.");
  }
  // Viewers can't own RFPs, so a member who owns some can't become one until they're reassigned.
  if (role === "viewer" && input.ownedRfpCount > 0) return ownerHasRfps(input.ownedRfpCount);
  return allow;
};

export const decideDeactivation = (input: { actor: ManagerFacts; target: MemberFacts; ownedRfpCount: number }): Decision => {
  const { actor, target } = input;
  if (target.status === "removed") return refuse(409, "MEMBER_REMOVED", "This member has been removed.");
  if (isOwner(target.roles)) return isOwner(actor.roles) ? lastOwner() : ownerOnly();
  if (input.ownedRfpCount > 0) return ownerHasRfps(input.ownedRfpCount);
  return allow;
};

export const decideReactivation = (input: { target: MemberFacts }): Decision =>
  input.target.status === "suspended" || input.target.status === "active"
    ? allow
    : refuse(409, "MEMBER_NOT_DEACTIVATED", "Only a deactivated member can be reactivated.");

export const decideOwnershipTransfer = (input: { actor: ManagerFacts; target: MemberFacts | null }): Decision => {
  if (!isOwner(input.actor.roles)) return refuse(403, "OWNER_ONLY", "Only the Owner can transfer ownership.");
  if (!input.target) return refuse(404, "MEMBER_NOT_FOUND", "Member not found.");
  if (input.target.userId === input.actor.userId) return refuse(400, "ALREADY_OWNER", "You are already the Owner.");
  if (input.target.status !== "active") return refuse(409, "MEMBER_INACTIVE", "Ownership can only go to an active member.");
  return allow;
};

// ORG-207: RFPs can move to an active member who is allowed to own RFPs (not a Viewer).
const RFP_OWNER_ROLES: readonly CustomerRole[] = ["owner", "organization_admin", "team_manager", "planner"];
export const canOwnRfps = (roles: readonly string[]) => roles.some((role) => (RFP_OWNER_ROLES as readonly string[]).includes(role));
export const MAX_SELECTED_RFPS = 1000;

export const decideReassignment = (input: { from: MemberFacts | null; to: MemberFacts | null }): Decision => {
  if (!input.from) return refuse(404, "MEMBER_NOT_FOUND", "Member not found.");
  if (!input.to) return refuse(404, "REASSIGN_TARGET_NOT_FOUND", "The member receiving the RFPs was not found.");
  if (input.from.userId === input.to.userId) return refuse(400, "REASSIGN_TO_SELF", "Choose a different member to receive the RFPs.");
  if (input.to.status !== "active" || !canOwnRfps(input.to.roles)) {
    return refuse(409, "REASSIGN_TARGET_INELIGIBLE", "RFPs can only go to an active member who isn't a Viewer.");
  }
  return allow;
};

// API status names: a suspended membership is shown as deactivated.
export const publicStatus = (status: MemberStatus) => (status === "suspended" ? "deactivated" : status);
