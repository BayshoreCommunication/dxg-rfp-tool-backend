import {
  customerRole,
  decideDeactivation,
  decideManage,
  decideOwnershipTransfer,
  decideReassignment,
  MAX_SELECTED_RFPS,
  decideReactivation,
  decideRoleChange,
  isAssignableRole,
  ownerHasRfps,
  publicStatus,
  withCustomerRole,
  type CustomerRole,
  type Refusal,
} from "../domain/memberPolicy";
import type { MemberAuditWriter, MemberRecord, MembershipStore, MemberSessionHooks, RfpOwnershipMirror, RfpReassignmentStore, TeamDirectory, TeamRef } from "../domain/ports";

// ORG-206 membership management: list, change role, deactivate, reactivate, and the ownership
// transfer. Every change is optimistic on the membership version and audited, refusals included.

export type MemberActor = {
  organizationId: string;
  userId: string;
  roles: readonly string[];
  sessionId?: string;
  correlationId: string;
};

export type MemberView = {
  userId: string;
  membershipId: string;
  name: string | null;
  email: string | null;
  role: CustomerRole | null;
  roles: string[];
  teams: TeamRef[];
  status: string;
  lastSignedInAt: string | null;
  version: number;
  joinedAt: string | null;
};

export type MemberResult<T> = ({ ok: true } & T) | Refusal;

type Dependencies = {
  store: MembershipStore;
  teams: TeamDirectory;
  audit: MemberAuditWriter;
  sessions: MemberSessionHooks;
  reassignments: RfpReassignmentStore;
  ownershipMirror: RfpOwnershipMirror;
  now?: () => Date;
};

const refusal = (status: Refusal["status"], code: string, message: string, details?: Record<string, unknown>): Refusal =>
  ({ ok: false, status, code, message, ...(details ? { details } : {}) });
const notFound = () => refusal(404, "MEMBER_NOT_FOUND", "Member not found.");
const stale = (current: MemberRecord | null) =>
  refusal(409, "STALE_VERSION", "This member was changed by someone else. Reload and try again.", { currentVersion: current?.version ?? null });

export const parseVersion = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
const versionRequired = () => refusal(400, "VERSION_REQUIRED", "The member's current version is required.");

const toView = (member: MemberRecord, teams: TeamRef[] = []): MemberView => ({
  userId: member.userId,
  membershipId: member.membershipId,
  name: member.name,
  email: member.email,
  role: customerRole(member.roles),
  roles: member.roles,
  teams,
  status: publicStatus(member.status),
  lastSignedInAt: member.lastSignedInAt ? member.lastSignedInAt.toISOString() : null,
  version: member.version,
  joinedAt: member.createdAt ? member.createdAt.toISOString() : null,
});

export const createMemberManagement = (dependencies: Dependencies) => {
  const now = dependencies.now ?? (() => new Date());

  const audit = (actor: MemberActor, input: {
    action: string; targetUserId: string; decision: "allowed" | "denied"; reason: string; metadata?: Record<string, unknown>;
  }) => dependencies.audit.append({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: input.action,
    targetType: "organization_membership",
    targetId: input.targetUserId,
    decision: input.decision,
    reason: input.reason,
    correlationId: actor.correlationId,
    metadata: input.metadata,
  });

  // Policy refusals are audited as denied; malformed requests and unknown members are not.
  const refuse = async (actor: MemberActor, action: string, targetUserId: string, result: Refusal): Promise<Refusal> => {
    if (result.status === 403 || result.status === 409) {
      await audit(actor, { action, targetUserId, decision: "denied", reason: result.code.toLowerCase(), metadata: result.details });
    }
    return result;
  };

  const sessionChange = (actor: MemberActor, userId: string) =>
    ({ organizationId: actor.organizationId, userId, actorUserId: actor.userId, actorSessionId: actor.sessionId, correlationId: actor.correlationId });

  const viewWithTeams = async (actor: MemberActor, member: MemberRecord) =>
    toView(member, (await dependencies.teams.teamsFor(actor.organizationId, [member.userId])).get(member.userId) ?? []);

  const list = async (actor: MemberActor, filter: { q?: string; status?: string; role?: string } = {}): Promise<MemberResult<{ members: MemberView[] }>> => {
    const manage = decideManage(actor);
    if (!manage.ok) return manage;
    const all = await dependencies.store.list(actor.organizationId);
    const q = filter.q?.trim().toLowerCase();
    const members = all
      .filter((m) => (filter.status ? publicStatus(m.status) === filter.status : m.status !== "removed"))
      .filter((m) => !filter.role || customerRole(m.roles) === filter.role)
      .filter((m) => !q || [m.name, m.email].some((v) => v?.toLowerCase().includes(q)));
    const teams = await dependencies.teams.teamsFor(actor.organizationId, members.map((m) => m.userId));
    return {
      ok: true,
      members: members
        .map((m) => toView(m, teams.get(m.userId) ?? []))
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")),
    };
  };

  const changeRole = async (actor: MemberActor, input: { userId: string; role: unknown; version: unknown }): Promise<MemberResult<{ member: MemberView; previousRole: CustomerRole | null }>> => {
    const action = "organization.member.role_changed";
    const manage = decideManage(actor);
    if (!manage.ok) return refuse(actor, action, input.userId, manage);
    if (input.role !== "owner" && !isAssignableRole(input.role)) {
      return refusal(400, "INVALID_ROLE", "Role must be one of organization_admin, team_manager, planner or viewer.");
    }
    const role = input.role as CustomerRole;
    const version = parseVersion(input.version);
    if (version === null) return versionRequired();
    const target = await dependencies.store.find(actor.organizationId, input.userId);
    if (!target) return notFound();
    if (target.version !== version) return refuse(actor, action, input.userId, stale(target));
    const previousRole = customerRole(target.roles);
    const ownedRfpCount = role === "viewer" ? await dependencies.store.countOwnedRfps(actor.organizationId, target.userId) : 0;
    const decision = decideRoleChange({ actor, target, role, ownedRfpCount });
    if (!decision.ok) return refuse(actor, action, input.userId, decision);
    if (previousRole === role) return { ok: true, member: await viewWithTeams(actor, target), previousRole };

    const updated = await dependencies.store.setRoles({
      organizationId: actor.organizationId, userId: target.userId, expectedVersion: version, roles: withCustomerRole(target.roles, role),
    });
    if (updated === "stale") return refuse(actor, action, input.userId, stale(await dependencies.store.find(actor.organizationId, input.userId)));
    await audit(actor, { action, targetUserId: target.userId, decision: "allowed", reason: "role_changed", metadata: { previousRole, role, version: updated.version } });
    await dependencies.sessions.afterRoleChange(sessionChange(actor, target.userId));
    return { ok: true, member: await viewWithTeams(actor, updated), previousRole };
  };

  const deactivate = async (actor: MemberActor, input: { userId: string; version: unknown }): Promise<MemberResult<{ member: MemberView }>> => {
    const action = "organization.member.deactivated";
    const manage = decideManage(actor);
    if (!manage.ok) return refuse(actor, action, input.userId, manage);
    const version = parseVersion(input.version);
    if (version === null) return versionRequired();
    const target = await dependencies.store.find(actor.organizationId, input.userId);
    if (!target) return notFound();
    if (target.version !== version) return refuse(actor, action, input.userId, stale(target));
    if (target.status === "suspended") return { ok: true, member: await viewWithTeams(actor, target) };
    const ownedRfpCount = await dependencies.store.countOwnedRfps(actor.organizationId, target.userId);
    const decision = decideDeactivation({ actor, target, ownedRfpCount });
    if (!decision.ok) return refuse(actor, action, input.userId, decision);

    const updated = await dependencies.store.deactivate({ organizationId: actor.organizationId, userId: target.userId, expectedVersion: version, now: now() });
    if (updated === "stale") return refuse(actor, action, input.userId, stale(await dependencies.store.find(actor.organizationId, input.userId)));
    if ("ownedRfpCount" in updated) return refuse(actor, action, input.userId, ownerHasRfps(updated.ownedRfpCount));
    await audit(actor, { action, targetUserId: target.userId, decision: "allowed", reason: "member_deactivated", metadata: { previousStatus: target.status, version: updated.version } });
    await dependencies.sessions.afterDeactivation(sessionChange(actor, target.userId));
    return { ok: true, member: await viewWithTeams(actor, updated) };
  };

  const reactivate = async (actor: MemberActor, input: { userId: string; version: unknown }): Promise<MemberResult<{ member: MemberView }>> => {
    const action = "organization.member.reactivated";
    const manage = decideManage(actor);
    if (!manage.ok) return refuse(actor, action, input.userId, manage);
    const version = parseVersion(input.version);
    if (version === null) return versionRequired();
    const target = await dependencies.store.find(actor.organizationId, input.userId);
    if (!target) return notFound();
    if (target.version !== version) return refuse(actor, action, input.userId, stale(target));
    const decision = decideReactivation({ target });
    if (!decision.ok) return refuse(actor, action, input.userId, decision);
    if (target.status === "active") return { ok: true, member: await viewWithTeams(actor, target) };

    const updated = await dependencies.store.reactivate({ organizationId: actor.organizationId, userId: target.userId, expectedVersion: version });
    if (updated === "stale") return refuse(actor, action, input.userId, stale(await dependencies.store.find(actor.organizationId, input.userId)));
    await audit(actor, { action, targetUserId: target.userId, decision: "allowed", reason: "member_reactivated", metadata: { version: updated.version } });
    return { ok: true, member: await viewWithTeams(actor, updated) };
  };

  // The Owner hands the role to another active member and becomes an Admin, atomically, so the
  // organization has exactly one active Owner before and after.
  const transferOwnership = async (actor: MemberActor, input: { toUserId: unknown; version: unknown }): Promise<MemberResult<{ previousOwner: MemberView; owner: MemberView }>> => {
    const action = "organization.ownership.transferred";
    const toUserId = typeof input.toUserId === "string" ? input.toUserId : "";
    if (!/^[a-f0-9]{24}$/i.test(toUserId)) return refusal(400, "MEMBER_REQUIRED", "Choose the member who becomes the Owner.");
    const version = parseVersion(input.version);
    if (version === null) return versionRequired();
    const target = await dependencies.store.find(actor.organizationId, toUserId);
    const decision = decideOwnershipTransfer({ actor, target });
    if (!decision.ok) return refuse(actor, action, toUserId, decision);
    if (target!.version !== version) return refuse(actor, action, toUserId, stale(target));

    const result = await dependencies.store.transferOwnership({
      organizationId: actor.organizationId, fromUserId: actor.userId, toUserId, expectedTargetVersion: version,
    });
    if (result === "not_owner") return refuse(actor, action, toUserId, refusal(403, "OWNER_ONLY", "Only the Owner can transfer ownership."));
    if (result === "stale") return refuse(actor, action, toUserId, stale(await dependencies.store.find(actor.organizationId, toUserId)));
    await audit(actor, {
      action, targetUserId: toUserId, decision: "allowed", reason: "ownership_transferred",
      metadata: { previousOwnerUserId: actor.userId, newOwnerPreviousRole: customerRole(target!.roles), previousOwnerNewRole: "organization_admin" },
    });
    await dependencies.sessions.afterRoleChange(sessionChange(actor, actor.userId));
    await dependencies.sessions.afterRoleChange(sessionChange(actor, toUserId));
    return { ok: true, previousOwner: await viewWithTeams(actor, result.from), owner: await viewWithTeams(actor, result.to) };
  };

  // ORG-207 offboarding: move all, or the selected, RFPs owned by one member to another active
  // non-Viewer member, with one audit event per RFP. Deactivation is then allowed.
  const reassignRfps = async (actor: MemberActor, input: { fromUserId: string; toUserId: unknown; rfpIds?: unknown }): Promise<MemberResult<{ reassignedCount: number; rfpIds: string[] }>> => {
    const action = "proposal.owner.reassigned";
    const manage = decideManage(actor);
    if (!manage.ok) return refuse(actor, action, input.fromUserId, manage);
    const toUserId = typeof input.toUserId === "string" ? input.toUserId : "";
    if (!/^[a-f0-9]{24}$/i.test(toUserId)) return refusal(400, "REASSIGN_TARGET_REQUIRED", "Choose the member who receives the RFPs.");
    let rfpIds: string[] | null = null;
    if (input.rfpIds !== undefined && input.rfpIds !== "all") {
      if (!Array.isArray(input.rfpIds) || input.rfpIds.length === 0 || input.rfpIds.length > MAX_SELECTED_RFPS ||
        !input.rfpIds.every((id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id))) {
        return refusal(400, "INVALID_RFP_SELECTION", `Select between 1 and ${MAX_SELECTED_RFPS} RFPs, or omit rfpIds to reassign all.`);
      }
      rfpIds = [...new Set(input.rfpIds as string[])];
    }
    const [from, to] = await Promise.all([
      dependencies.store.find(actor.organizationId, input.fromUserId),
      dependencies.store.find(actor.organizationId, toUserId),
    ]);
    const decision = decideReassignment({ from, to });
    if (!decision.ok) return refuse(actor, action, input.fromUserId, decision);

    const result = await dependencies.reassignments.reassign({ organizationId: actor.organizationId, fromUserId: input.fromUserId, toUserId, rfpIds });
    if (result === "target_ineligible") {
      return refuse(actor, action, input.fromUserId, refusal(409, "REASSIGN_TARGET_INELIGIBLE", "RFPs can only go to an active member who isn't a Viewer."));
    }
    if ("notOwnedCount" in result) {
      return refusal(409, "RFPS_NOT_OWNED_BY_MEMBER", "Some selected RFPs aren't owned by this member. Nothing was reassigned.", { notOwnedCount: result.notOwnedCount });
    }
    for (const rfpId of result.rfpIds) {
      await dependencies.audit.append({
        organizationId: actor.organizationId, actorUserId: actor.userId, action, targetType: "proposal", targetId: rfpId,
        decision: "allowed", reason: "offboarding_reassignment", correlationId: actor.correlationId,
        metadata: { fromUserId: input.fromUserId, toUserId },
      });
    }
    if (result.rfpIds.length > 0) await dependencies.ownershipMirror.afterReassign({ organizationId: actor.organizationId, rfpIds: result.rfpIds, toUserId });
    return { ok: true, reassignedCount: result.rfpIds.length, rfpIds: result.rfpIds };
  };

  return { list, changeRole, deactivate, reactivate, transferOwnership, reassignRfps };
};

export type MemberManagement = ReturnType<typeof createMemberManagement>;
