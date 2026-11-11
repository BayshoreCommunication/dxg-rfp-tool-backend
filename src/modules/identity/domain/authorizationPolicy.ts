export const ORGANIZATION_ACTIONS = [
  "proposal:read", "proposal:write", "proposal:publish",
  "assistant:use",
  "knowledge:read", "knowledge:write", "knowledge:approve",
  "vendor-response:read", "vendor-response:write",
  "organization:manage", "security:admin",
  // ORG-606: the organization's shared vendor list (companies and contacts).
  "vendor-list:read", "vendor-list:write",
  // ORG-604: RFP templates. "use" covers personal templates and starting an RFP from a template;
  // "publish" covers managing organization templates (publish, unpublish, archive).
  "template:use", "template:publish",
] as const;
export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];

// Coarse capabilities only. Which proposals a role reaches is decided by rfpAccessPolicy.
// Vendor list (DXG decision Q4, F6): Owner, Admin and Team Manager edit it, every role that can
// create RFPs reads it, Viewers and knowledge roles don't see it.
// Templates (Q4, F6): every role that can create RFPs uses them, Owner and Admin manage the
// organization's, Viewers and knowledge roles get neither.
const roleActions: Record<string, readonly OrganizationAction[]> = {
  owner: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "knowledge:write", "knowledge:approve", "vendor-response:read", "vendor-response:write", "organization:manage", "vendor-list:read", "vendor-list:write", "template:use", "template:publish"],
  team_manager: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "vendor-response:read", "vendor-response:write", "vendor-list:read", "vendor-list:write", "template:use"],
  viewer: ["proposal:read", "vendor-response:read"],
  planner: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "vendor-response:read", "vendor-response:write", "vendor-list:read", "template:use"],
  organization_admin: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "knowledge:write", "knowledge:approve", "vendor-response:read", "vendor-response:write", "organization:manage", "vendor-list:read", "vendor-list:write", "template:use", "template:publish"],
  dxg_producer: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "vendor-response:read", "vendor-response:write", "vendor-list:read", "template:use"],
  knowledge_editor: ["proposal:read", "knowledge:read", "knowledge:write"],
  knowledge_approver: ["proposal:read", "knowledge:read", "knowledge:write", "knowledge:approve"],
  dxg_admin: ORGANIZATION_ACTIONS,
  super_admin: ORGANIZATION_ACTIONS,
};

export const hasOrganizationAction = (roles: readonly string[], action: OrganizationAction) =>
  roles.some((role) => roleActions[role]?.includes(action));

export const legacyAuthorizationRoles = (role: string): string[] => {
  const normalized = role.toLowerCase().trim().replace(/[\s-]/g, "_");
  if (normalized === "superadmin" || normalized === "super_admin") return ["super_admin"];
  if (normalized === "admin") return ["dxg_admin", "super_admin"];
  // A "customer" guard means any customer role. It used to expand to planner, organization_admin
  // and dxg_producer, which granted every customer administrator and producer rights (ORG-106).
  if (normalized === "customer") return ["owner", "organization_admin", "team_manager", "planner", "viewer"];
  return [normalized];
};
