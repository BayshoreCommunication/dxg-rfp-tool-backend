export const ORGANIZATION_ACTIONS = [
  "proposal:read", "proposal:write", "proposal:publish",
  "assistant:use",
  "knowledge:read", "knowledge:write", "knowledge:approve",
  "vendor-response:read", "vendor-response:write",
  "organization:manage", "security:admin",
] as const;
export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];

// Coarse capabilities only. Which proposals a role reaches is decided by rfpAccessPolicy.
const roleActions: Record<string, readonly OrganizationAction[]> = {
  owner: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "knowledge:write", "knowledge:approve", "vendor-response:read", "vendor-response:write", "organization:manage"],
  team_manager: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "vendor-response:read", "vendor-response:write"],
  viewer: ["proposal:read", "vendor-response:read"],
  planner: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "vendor-response:read", "vendor-response:write"],
  organization_admin: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "knowledge:write", "knowledge:approve", "vendor-response:read", "vendor-response:write", "organization:manage"],
  dxg_producer: ["proposal:read", "proposal:write", "proposal:publish", "assistant:use", "knowledge:read", "vendor-response:read", "vendor-response:write"],
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
