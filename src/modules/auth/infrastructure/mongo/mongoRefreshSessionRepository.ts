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
    const token = await RefreshSession.findOne({ $or: [{ tokenHash }, { consumedTokenHashes: tokenHash }] }).select("+tokenHash +lastRotation").lean();
    return token ? {
      id: String(token._id),
      organizationId: String(token.organizationId),
      userId: String(token.userId),
      sessionId: token.sessionId,
      familyId: token.familyId,
      tokenId: token.tokenId,
      tokenHash: token.tokenHash,
      rotationCount: token.rotationCount ?? 0,
      lastRotation: token.lastRotation,
      status: token.status,
      expiresAt: token.expiresAt,
      idleExpiresAt: token.idleExpiresAt,
    } : null;
  },
  async rotateActive({ id, previousHash, tokenHash, tokenId, keyHash, now, maxRotations }) {
    // One document owns this session across rotations. Revocation and rotation
    // now contend on the same row: logout can never be followed by child insert.
    const result = await RefreshSession.updateOne(
      { _id: id, tokenHash: previousHash, status: "active",
        expiresAt: { $gt: now }, idleExpiresAt: { $gt: now },
        $or: [{ rotationCount: { $lt: maxRotations } }, { rotationCount: { $exists: false } }],
      },
      { $set: { tokenHash, tokenId, lastUsedAt: now, lastRotation: { previousHash, keyHash, at: now } },
        $push: { consumedTokenHashes: previousHash }, $inc: { rotationCount: 1 } },
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
