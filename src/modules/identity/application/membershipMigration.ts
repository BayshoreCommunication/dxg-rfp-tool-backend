import type { OrganizationRole } from "../../../../modal/organizationMembershipModel";

export const legacyRoleToMembershipRoles = (legacyRole?: string): OrganizationRole[] => {
  const role = String(legacyRole ?? "customer").toLowerCase().trim().replace(/[\s-]/g, "_");
  if (role === "super_admin" || role === "superadmin") return ["super_admin"];
  if (role === "admin") return ["dxg_admin"];
  return ["planner"];
};

export type LegacyMembershipCandidate = {
  organizationId: string;
  userId: string;
  roles: OrganizationRole[];
  status: "active";
  version: 1;
  activatedAt: Date;
  migrationRunId: string;
};

export const buildLegacyMembershipCandidate = (input: {
  organizationId: string;
  userId: string;
  legacyRole?: string;
  migrationRunId: string;
  activatedAt?: Date;
}): LegacyMembershipCandidate => ({
  organizationId: input.organizationId,
  userId: input.userId,
  roles: legacyRoleToMembershipRoles(input.legacyRole),
  status: "active",
  version: 1,
  activatedAt: input.activatedAt ?? new Date(),
  migrationRunId: input.migrationRunId,
});
