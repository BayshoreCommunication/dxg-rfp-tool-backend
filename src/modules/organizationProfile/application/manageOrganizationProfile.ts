/* The organization's display name. A Google or Microsoft sign-up creates the
   organization before anyone has named it ("Pat's organization", needsName set),
   so the dashboard asks the Owner for the company name right after sign-up.
   Callers have already checked organization:manage for a rename. */

export interface OrganizationProfileDirectory {
  find(organizationId: string): Promise<{ name: string; needsName: boolean } | null>;
  rename(organizationId: string, name: string): Promise<void>;
}

export interface OrganizationProfileAudit {
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

export const ORGANIZATION_NAME_MAX_LENGTH = 200;

/** Trimmed, inner whitespace collapsed; null when empty, too long or not a string. */
export const normalizeOrganizationName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > ORGANIZATION_NAME_MAX_LENGTH) return null;
  return name;
};

export const createOrganizationProfile = (dependencies: {
  directory: OrganizationProfileDirectory;
  audit: OrganizationProfileAudit;
}) => {
  const profile = async (organizationId: string) => dependencies.directory.find(organizationId);

  const rename = async (input: { organizationId: string; actorUserId: string; name: unknown; correlationId: string }) => {
    const name = normalizeOrganizationName(input.name);
    if (!name) return { kind: "validation" as const };
    const current = await dependencies.directory.find(input.organizationId);
    if (!current) return { kind: "not_found" as const };
    await dependencies.directory.rename(input.organizationId, name);
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "organization.settings.updated",
      targetType: "organization",
      targetId: input.organizationId,
      decision: "allowed",
      reason: current.needsName ? "organization_named" : "organization_renamed",
      correlationId: input.correlationId,
      metadata: { setting: "name" },
    });
    return { kind: "updated" as const, name, needsName: false };
  };

  return { profile, rename };
};
