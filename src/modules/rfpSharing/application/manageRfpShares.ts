import { canAccessRfp, type RfpRef, type SharePermission } from "../../identity/domain/rfpAccessPolicy";
import type { SecurityAuditWriter } from "../../auth/domain/ports/sessionPorts";
import {
  ShareError,
  type ShareActor,
  type ShareMemberDirectory,
  type SharedProposalLookup,
  type ShareRepository,
  type ShareView,
} from "../domain";

type Dependencies = {
  shares: ShareRepository;
  proposals: SharedProposalLookup;
  directory: ShareMemberDirectory;
  audit: SecurityAuditWriter;
  isValidId(value: string): boolean;
};

const PERMISSIONS: readonly SharePermission[] = ["view", "edit"];
// Roles a share can reach (rfpAccessPolicy gives other roles nothing through a share).
const EDIT_SHARE_ROLES = ["owner", "organization_admin", "team_manager", "planner"];
const SHAREABLE_ROLES = [...EDIT_SHARE_ROLES, "viewer"];

const proposalNotFound = () => new ShareError("PROPOSAL_NOT_FOUND", "Proposal not found.", 404);
const memberNotFound = () => new ShareError("MEMBER_NOT_FOUND", "Member not found in this organization.", 404);

// Share and unshare: the proposal's owner, a manager of its team, or an Owner/Admin (the policy's
// "share" action). Shares stay inside the organization, and Viewers only ever get view.
export const createRfpSharing = (dependencies: Dependencies) => {
  const { shares, proposals, directory, audit } = dependencies;

  const organizationOf = (actor: ShareActor) => String(actor.rfpActor.organizationId);

  const loadShareable = async (actor: ShareActor, proposalId: string): Promise<RfpRef> => {
    const proposal = dependencies.isValidId(proposalId) ? await proposals.find(organizationOf(actor), proposalId) : null;
    if (!proposal) throw proposalNotFound();
    const decision = canAccessRfp(actor.rfpActor, proposal, "share");
    if (!decision.allowed) {
      if (decision.reason === "not_found") throw proposalNotFound();
      throw new ShareError("SHARE_NOT_ALLOWED", "Only the proposal's owner, its team's manager or an Admin can share it.", 403);
    }
    return proposal;
  };

  const record = (actor: ShareActor, action: string, proposalId: string, decision: "created" | "revoked", metadata: Record<string, unknown>) =>
    audit.append({
      organizationId: organizationOf(actor),
      actorUserId: String(actor.rfpActor.userId),
      action,
      targetType: "proposal",
      targetId: proposalId,
      decision,
      reason: action,
      correlationId: actor.correlationId,
      metadata,
    });

  const list = async (actor: ShareActor, proposalId: string): Promise<ShareView[]> => {
    await loadShareable(actor, proposalId);
    const records = await shares.list(organizationOf(actor), proposalId);
    const members = await directory.find(organizationOf(actor), records.map((share) => share.userId));
    return records.map((share) => ({ ...share, memberActive: members.get(share.userId)?.status === "active" }));
  };

  return {
    list,

    async grant(actor: ShareActor, proposalId: string, userId: string, input: { permission: unknown }): Promise<ShareView[]> {
      const permission = input.permission as SharePermission;
      if (!PERMISSIONS.includes(permission)) throw new ShareError("INVALID_SHARE_PERMISSION", "permission must be view or edit.", 400);
      const proposal = await loadShareable(actor, proposalId);
      const member = dependencies.isValidId(userId) ? (await directory.find(organizationOf(actor), [userId])).get(userId) : undefined;
      if (!member || !member.roles.some((role) => SHAREABLE_ROLES.includes(role))) throw memberNotFound();
      if (member.status !== "active") throw new ShareError("MEMBER_INACTIVE", "This member is deactivated.", 409);
      if (String(proposal.ownerUserId) === userId) throw new ShareError("SHARE_TARGET_IS_OWNER", "The owner already has this proposal.", 409);
      if (permission === "edit" && !member.roles.some((role) => EDIT_SHARE_ROLES.includes(role))) {
        throw new ShareError("VIEWER_VIEW_ONLY", "Viewers can only be given view access.", 422);
      }
      const previous = await shares.upsert({ organizationId: organizationOf(actor), proposalId, userId, permission, grantedBy: String(actor.rfpActor.userId) });
      if (previous !== permission) {
        await record(actor, "proposal.share_granted", proposalId, "created", { userId, permission, previousPermission: previous });
      }
      return list(actor, proposalId);
    },

    async revoke(actor: ShareActor, proposalId: string, userId: string): Promise<ShareView[]> {
      await loadShareable(actor, proposalId);
      const removed = dependencies.isValidId(userId) ? await shares.remove({ organizationId: organizationOf(actor), proposalId, userId }) : null;
      if (!removed) throw new ShareError("SHARE_NOT_FOUND", "This proposal isn't shared with that member.", 404);
      await record(actor, "proposal.share_revoked", proposalId, "revoked", { userId, permission: removed });
      return list(actor, proposalId);
    },
  };
};

export type RfpSharing = ReturnType<typeof createRfpSharing>;
