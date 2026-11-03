import type { TwoFactorAudit, TwoFactorService } from "./manageTwoFactor";

/* ORG-304: the organization's "require 2FA" setting and an Admin's reset of a
   member's 2FA. Callers have already checked organization:manage. */

export interface OrganizationTwoFactorDirectory {
  requiresTwoFactor(organizationId: string): Promise<boolean>;
  setRequiresTwoFactor(organizationId: string, value: boolean): Promise<void>;
  membership(organizationId: string, userId: string): Promise<{ roles: string[]; status: string } | null>;
  /** True when the user is also an active member of any other organization. */
  activeElsewhere(organizationId: string, userId: string): Promise<boolean>;
  activeMemberIds(organizationId: string): Promise<string[]>;
  enrolledUserIds(userIds: string[]): Promise<string[]>;
}

type Dependencies = {
  directory: OrganizationTwoFactorDirectory;
  twoFactor: Pick<TwoFactorService, "adminReset">;
  revokeMemberSessions(input: { userId: string; organizationId: string; correlationId: string; reason: string }): Promise<number>;
  audit: TwoFactorAudit;
};

export const createOrganizationTwoFactorPolicy = (dependencies: Dependencies) => {
  const settings = async (organizationId: string) => {
    const [requireTwoFactor, memberIds] = await Promise.all([
      dependencies.directory.requiresTwoFactor(organizationId),
      dependencies.directory.activeMemberIds(organizationId),
    ]);
    const enrolled = new Set(await dependencies.directory.enrolledUserIds(memberIds));
    return { requireTwoFactor, activeMembers: memberIds.length, membersWithoutTwoFactor: memberIds.filter((id) => !enrolled.has(id)).length };
  };

  /**
   * Turning the requirement on signs out every active member who hasn't enrolled, so the
   * routing to enrolment happens now rather than whenever their session ends; until they
   * enrol, sign-in gives them only an enrolment challenge. The acting Admin must have 2FA
   * first so they can't require what they don't have.
   */
  const setRequireTwoFactor = async (input: { organizationId: string; actorUserId: string; requireTwoFactor: unknown; correlationId: string }) => {
    if (typeof input.requireTwoFactor !== "boolean") return { kind: "validation" as const };
    const current = await dependencies.directory.requiresTwoFactor(input.organizationId);
    if (current === input.requireTwoFactor) return { kind: "unchanged" as const, requireTwoFactor: current, signedOutMembers: 0 };
    let signedOutMembers = 0;
    if (input.requireTwoFactor) {
      const [actorEnrolled] = await dependencies.directory.enrolledUserIds([input.actorUserId]);
      if (!actorEnrolled) return { kind: "actor_not_enrolled" as const };
      await dependencies.directory.setRequiresTwoFactor(input.organizationId, true);
      const memberIds = await dependencies.directory.activeMemberIds(input.organizationId);
      const enrolled = new Set(await dependencies.directory.enrolledUserIds(memberIds));
      for (const userId of memberIds.filter((id) => !enrolled.has(id))) {
        const revoked = await dependencies.revokeMemberSessions({
          userId, organizationId: input.organizationId, correlationId: input.correlationId, reason: "two_factor_required",
        });
        if (revoked > 0) signedOutMembers += 1;
      }
    } else {
      await dependencies.directory.setRequiresTwoFactor(input.organizationId, false);
    }
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "organization.settings.updated",
      targetType: "organization",
      targetId: input.organizationId,
      decision: "allowed",
      reason: input.requireTwoFactor ? "require_two_factor_enabled" : "require_two_factor_disabled",
      correlationId: input.correlationId,
      metadata: { setting: "requireTwoFactor", from: current, to: input.requireTwoFactor, signedOutMembers },
    });
    return { kind: "updated" as const, requireTwoFactor: input.requireTwoFactor, signedOutMembers };
  };

  const resetMember = async (input: { organizationId: string; actorUserId: string; actorRoles: string[]; targetUserId: string; correlationId: string }) => {
    if (input.targetUserId === input.actorUserId) return { kind: "self" as const };
    const target = await dependencies.directory.membership(input.organizationId, input.targetUserId);
    // Members of other organizations look the same as nobody.
    if (!target || target.status === "removed") return { kind: "not_found" as const };
    // An organization_admin can't strip the Owner's second factor; the Owner can reset anyone.
    if (target.roles.includes("owner") && !input.actorRoles.includes("owner")) return { kind: "forbidden" as const };
    // The enrolment is per user, not per organization: removing it here would strip the factor
    // another organization relies on and leave that organization's sessions running. DXG
    // support resets those through twoFactor.adminReset directly.
    if (await dependencies.directory.activeElsewhere(input.organizationId, input.targetUserId)) return { kind: "member_of_other_organization" as const };
    return dependencies.twoFactor.adminReset({
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      organizationId: input.organizationId,
      correlationId: input.correlationId,
    });
  };

  return { settings, setRequireTwoFactor, resetMember };
};
