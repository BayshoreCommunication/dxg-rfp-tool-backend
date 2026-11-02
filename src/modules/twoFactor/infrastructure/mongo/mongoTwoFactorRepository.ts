import UserTwoFactor from "../../../../../modal/userTwoFactorModel";
import TwoFactorChallenge from "../../../../../modal/twoFactorChallengeModel";
import type {
  TwoFactorChallengeRecord,
  TwoFactorChallengeRepository,
  TwoFactorRecord,
  TwoFactorRepository,
} from "../../application/manageTwoFactor";

type StoredRecord = {
  userId: unknown; organizationId: unknown; status: "pending" | "enabled"; secretCiphertext: string;
  lastUsedStep: number; recoveryCodes?: Array<{ hash: string; usedAt?: Date | null }>;
  failedAttempts?: number; lockedUntil?: Date | null;
};

const toRecord = (row: StoredRecord): TwoFactorRecord => ({
  userId: String(row.userId),
  organizationId: String(row.organizationId),
  status: row.status,
  secretCiphertext: row.secretCiphertext,
  lastUsedStep: row.lastUsedStep,
  recoveryCodes: (row.recoveryCodes ?? []).map((code) => ({ hash: code.hash, usedAt: code.usedAt ?? null })),
  failedAttempts: row.failedAttempts ?? 0,
  lockedUntil: row.lockedUntil ?? null,
});

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

export const mongoTwoFactorRepository: TwoFactorRepository = {
  async find(userId) {
    const row = await UserTwoFactor.findOne({ userId }).select("+secretCiphertext +recoveryCodes").lean<StoredRecord | null>();
    return row ? toRecord(row) : null;
  },
  async savePending(input) {
    try {
      // Upserts only over a pending row: the filter can't match an enabled one, and the
      // unique userId index turns that upsert into a duplicate-key refusal.
      await UserTwoFactor.updateOne(
        { userId: input.userId, status: "pending" },
        {
          $set: { organizationId: input.organizationId, secretCiphertext: input.secretCiphertext, lastUsedStep: -1, failedAttempts: 0, lockedUntil: null },
          $setOnInsert: { userId: input.userId, status: "pending", recoveryCodes: [], enabledAt: null },
        },
        { upsert: true },
      );
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  },
  async enable(input) {
    const result = await UserTwoFactor.updateOne(
      { userId: input.userId, status: "pending", secretCiphertext: input.secretCiphertext },
      {
        $set: {
          status: "enabled",
          lastUsedStep: input.step,
          recoveryCodes: input.recoveryCodeHashes.map((hash) => ({ hash, usedAt: null })),
          enabledAt: input.now,
          failedAttempts: 0,
          lockedUntil: null,
        },
      },
    );
    return result.modifiedCount === 1;
  },
  async acceptStep(input) {
    const result = await UserTwoFactor.updateOne(
      { userId: input.userId, status: "enabled", lastUsedStep: { $lt: input.step } },
      { $set: { lastUsedStep: input.step, failedAttempts: 0, lockedUntil: null } },
    );
    return result.modifiedCount === 1;
  },
  async consumeRecoveryCode(input) {
    const result = await UserTwoFactor.updateOne(
      { userId: input.userId, status: "enabled", recoveryCodes: { $elemMatch: { hash: input.hash, usedAt: null } } },
      { $set: { "recoveryCodes.$.usedAt": input.now, failedAttempts: 0, lockedUntil: null } },
    );
    return result.modifiedCount === 1;
  },
  async recordFailure(input) {
    const row = await UserTwoFactor.findOneAndUpdate(
      { userId: input.userId },
      { $inc: { failedAttempts: 1 } },
      { new: true },
    ).select("failedAttempts").lean<{ failedAttempts: number } | null>();
    if (row && row.failedAttempts >= input.maxFailures) {
      await UserTwoFactor.updateOne(
        { userId: input.userId },
        { $set: { lockedUntil: new Date(input.now.getTime() + input.lockMs), failedAttempts: 0 } },
      );
    }
  },
  async replaceRecoveryCodes(input) {
    await UserTwoFactor.updateOne(
      { userId: input.userId, status: "enabled" },
      { $set: { recoveryCodes: input.hashes.map((hash) => ({ hash, usedAt: null })) } },
    );
  },
  async remove(userId) {
    const result = await UserTwoFactor.deleteOne({ userId });
    return result.deletedCount === 1;
  },
};

export const mongoTwoFactorChallengeRepository: TwoFactorChallengeRepository = {
  async create(input) {
    await TwoFactorChallenge.create({
      tokenHash: input.tokenHash,
      userId: input.userId,
      organizationId: input.organizationId,
      purpose: input.purpose,
      method: input.method,
      attempts: 0,
      expiresAt: input.expiresAt,
    });
  },
  async claimAttempt(input) {
    const row = await TwoFactorChallenge.findOneAndUpdate(
      { tokenHash: input.tokenHash, consumedAt: null, expiresAt: { $gt: input.now }, attempts: { $lt: input.maxAttempts } },
      { $inc: { attempts: 1 } },
      { new: true },
    ).lean<{ userId: unknown; organizationId: unknown; purpose: "verify" | "enrol"; method: "password" | "sso"; attempts: number } | null>();
    if (!row) return null;
    const record: TwoFactorChallengeRecord = {
      userId: String(row.userId),
      organizationId: String(row.organizationId),
      purpose: row.purpose,
      method: row.method,
      attempts: row.attempts,
    };
    return record;
  },
  async consume(input) {
    const result = await TwoFactorChallenge.updateOne(
      { tokenHash: input.tokenHash, consumedAt: null, expiresAt: { $gt: input.now } },
      { $set: { consumedAt: input.now } },
    );
    return result.modifiedCount === 1;
  },
};
