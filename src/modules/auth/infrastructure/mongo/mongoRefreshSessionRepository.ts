import RefreshSession from "../../../../../modal/refreshSessionModel";
import mongoose from "mongoose";
import type { RefreshSessionRepository } from "../../domain/ports/sessionPorts";

export const mongoRefreshSessionRepository: RefreshSessionRepository = {
  async create(input) {
    await RefreshSession.create({
      organizationId: input.organizationId,
      userId: input.userId,
      sessionId: input.sessionId,
      familyId: input.familyId,
      tokenId: input.tokenId,
      tokenHash: input.tokenHash,
      parentTokenId: input.parentTokenId ?? null,
      status: "active",
      expiresAt: input.expiresAt,
      idleExpiresAt: input.idleExpiresAt,
      lastUsedAt: input.now,
      userAgentHash: input.userAgentHash ?? null,
      ipHash: input.ipHash ?? null,
    });
  },
  async findByTokenHash(tokenHash) {
    const token = await RefreshSession.findOne({ tokenHash }).select("+tokenHash").lean();
    return token ? {
      id: String(token._id),
      organizationId: String(token.organizationId),
      userId: String(token.userId),
      sessionId: token.sessionId,
      familyId: token.familyId,
      tokenId: token.tokenId,
      status: token.status,
      expiresAt: token.expiresAt,
      idleExpiresAt: token.idleExpiresAt,
    } : null;
  },
  async consumeActive({ id, now }) {
    const result = await RefreshSession.updateOne(
      { _id: id, status: "active" },
      { $set: { status: "consumed", consumedAt: now, lastUsedAt: now } },
    );
    return result.modifiedCount === 1;
  },
  async revokeFamily({ familyId, reason, now }) {
    const result = await RefreshSession.updateMany(
      { familyId, status: { $ne: "revoked" } },
      { $set: { status: "revoked", revokedAt: now, revokeReason: reason } },
    );
    return result.modifiedCount;
  },
  async revokeSession({ sessionId, userId, reason, now }) {
    const result = await RefreshSession.updateMany(
      { sessionId, userId, status: { $ne: "revoked" } },
      { $set: { status: "revoked", revokedAt: now, revokeReason: reason } },
    );
    return result.modifiedCount;
  },
  async revokeAll({ userId, organizationId, reason, now }) {
    const result = await RefreshSession.updateMany(
      { userId, organizationId, status: { $ne: "revoked" } },
      { $set: { status: "revoked", revokedAt: now, revokeReason: reason } },
    );
    return result.modifiedCount;
  },
  async listActive({ userId, organizationId, now }) {
    const rows = await RefreshSession.aggregate<{
      _id: string;
      createdAt: Date;
      lastUsedAt: Date;
      expiresAt: Date;
      userAgentHash?: string | null;
      ipHash?: string | null;
    }>([
      { $match: {
        userId: new mongoose.Types.ObjectId(userId),
        organizationId: new mongoose.Types.ObjectId(organizationId),
        status: "active",
        expiresAt: { $gt: now },
        idleExpiresAt: { $gt: now },
      } },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: "$sessionId",
        createdAt: { $min: "$createdAt" },
        lastUsedAt: { $max: "$lastUsedAt" },
        expiresAt: { $max: "$expiresAt" },
        userAgentHash: { $first: "$userAgentHash" },
        ipHash: { $first: "$ipHash" },
      } },
    ]);
    return rows.map((row) => ({
      sessionId: row._id,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      userAgentHash: row.userAgentHash,
      ipHash: row.ipHash,
    }));
  },
};
