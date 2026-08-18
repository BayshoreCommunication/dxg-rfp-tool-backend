import PublicAccessGrant from "../../../../modal/publicAccessGrantModel";
import Proposal from "../../../../modal/proposalsModel";
import type { PublicAccessRepository } from "../application/managePublicAccess";

export const mongoPublicAccessRepository: PublicAccessRepository = {
  async resourceOwned(resourceId, organizationId, userId) {
    return Boolean(await Proposal.exists({ _id: resourceId, organizationId, userId }));
  },
  async create(input) {
    const grant = await PublicAccessGrant.create({ ...input, resourceType: "proposal", policyVersion: "public-access.v1" });
    return { id: String(grant._id) };
  },
  async consume(tokenHash, purpose, resourceId, now, recipientHash) {
    if (purpose === "vendor:submit" && recipientHash === undefined) return null;
    const grant = await PublicAccessGrant.findOneAndUpdate({
      tokenHash, purpose, resourceId, revokedAt: null, expiresAt: { $gt: now },
      ...(recipientHash ? { recipientHash } : {}),
      $expr: { $or: [{ $eq: ["$maxUses", null] }, { $lt: ["$useCount", "$maxUses"] }] },
    }, { $inc: { useCount: 1 }, $set: { lastUsedAt: now } }, { new: true }).select("+tokenHash").lean();
    return grant ? {
      organizationId: String(grant.organizationId), resourceId: String(grant.resourceId),
      purpose: grant.purpose, expiresAt: grant.expiresAt, maxUses: grant.maxUses,
      useCount: grant.useCount, revokedAt: grant.revokedAt,
    } : null;
  },
  async revoke(id, organizationId, reason) {
    const result = await PublicAccessGrant.updateOne({ _id: id, organizationId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
    return result.modifiedCount === 1;
  },
};
