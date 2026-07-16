export const ORGANIZATION_ACTIONS = [
  "proposal:read", "proposal:write", "proposal:publish",
  "knowledge:read", "knowledge:write", "knowledge:approve",
  "vendor-response:read", "organization:manage", "security:admin",
] as const;
export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];

const roleActions: Record<string, readonly OrganizationAction[]> = {
  planner: ["proposal:read", "proposal:write", "proposal:publish", "knowledge:read", "vendor-response:read"],
  organization_admin: ["proposal:read", "proposal:write", "proposal:publish", "knowledge:read", "knowledge:write", "knowledge:approve", "vendor-response:read", "organization:manage"],
  dxg_producer: ["proposal:read", "proposal:write", "proposal:publish", "knowledge:read", "vendor-response:read"],
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
  if (normalized === "customer") return ["planner", "organization_admin", "dxg_producer"];
  return [normalized];
};
