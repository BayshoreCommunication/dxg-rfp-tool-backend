import PublicAccessGrant from "../../../../modal/publicAccessGrantModel";
import Proposal from "../../../../modal/proposalsModel";
import { explainProposalMiss, proposalFilterFor } from "../../identity/application/proposalAccess";
import type { PublicAccessRepository } from "../application/managePublicAccess";

export const mongoPublicAccessRepository: PublicAccessRepository = {
  // Sending a proposal out (vendor link or view link) needs the policy's edit permission. A
  // refusal inside the organization throws ProposalAccessDeniedError (403).
  async resourceOwned(resourceId, organizationId, userId) {
    const who = { organizationId, userId };
    if (await Proposal.exists(await proposalFilterFor(who, "edit", { _id: resourceId }))) return true; // tenant-scoped: policy scope
    await explainProposalMiss(who, resourceId, "edit");
    return false;
  },
  async create(input) {
    const grant = await PublicAccessGrant.create({ ...input, resourceType: "proposal", policyVersion: "public-access.v1" });
    return { id: String(grant._id) };
  },
  async consume(tokenHash, purpose, resourceId, now, recipientHash) {
    if (purpose === "vendor:submit" && recipientHash === undefined) return null;
    // scope-exempt: the hashed token is the credential; the grant row carries its organization
    const grant = await PublicAccessGrant.findOneAndUpdate({
      tokenHash, purpose, resourceId, revokedAt: null, expiresAt: { $gt: now },
      ...(recipientHash ? { recipientHash } : {}),
      $expr: { $or: [{ $eq: ["$maxUses", null] }, { $lt: ["$useCount", "$maxUses"] }] },
    }, { $inc: { useCount: 1 }, $set: { lastUsedAt: now } }, { new: true }).select("+tokenHash").lean();
    return grant ? {
      id: String(grant._id),
      organizationId: String(grant.organizationId), resourceId: String(grant.resourceId),
      createdByUserId: String(grant.createdByUserId),
      recipientHash: grant.recipientHash ?? null,
      purpose: grant.purpose, expiresAt: grant.expiresAt, maxUses: grant.maxUses,
      useCount: grant.useCount, revokedAt: grant.revokedAt,
    } : null;
  },
  async revoke(id, organizationId, reason) {
    const result = await PublicAccessGrant.updateOne({ _id: id, organizationId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
    return result.modifiedCount === 1;
  },
};
