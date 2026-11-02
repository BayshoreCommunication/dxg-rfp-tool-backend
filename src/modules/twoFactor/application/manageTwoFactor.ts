import crypto from "node:crypto";
import type { SecretBox } from "../../../shared/security/secretBox";
import {
  decideSecondFactor,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  type PrimaryMethod,
  type SsoPolicy,
} from "../domain/secondFactorPolicy";
import { generateTotpSecret, matchTotpStep, otpauthUri } from "../domain/totp";

export type TwoFactorRecord = {
  userId: string;
  organizationId: string;
  status: "pending" | "enabled";
  secretCiphertext: string;
  lastUsedStep: number;
  recoveryCodes: Array<{ hash: string; usedAt: Date | null }>;
  failedAttempts: number;
  lockedUntil: Date | null;
};

export interface TwoFactorRepository {
  find(userId: string): Promise<TwoFactorRecord | null>;
  /** Replaces a pending row; refuses (false) when 2FA is already enabled. */
  savePending(input: { userId: string; organizationId: string; secretCiphertext: string }): Promise<boolean>;
  /** pending → enabled, only if the row still holds the secret the code was checked against. */
  enable(input: { userId: string; secretCiphertext: string; step: number; recoveryCodeHashes: string[]; now: Date }): Promise<boolean>;
  /** Atomic: succeeds only if step is above the last accepted step, which refuses replays. */
  acceptStep(input: { userId: string; step: number }): Promise<boolean>;
  /** Atomic: marks one unused recovery code used. */
  consumeRecoveryCode(input: { userId: string; hash: string; now: Date }): Promise<boolean>;
  recordFailure(input: { userId: string; now: Date; maxFailures: number; lockMs: number }): Promise<void>;
  replaceRecoveryCodes(input: { userId: string; hashes: string[] }): Promise<void>;
  remove(userId: string): Promise<boolean>;
}

export type TwoFactorChallengeRecord = {
  userId: string;
  organizationId: string;
  purpose: "verify" | "enrol";
  method: PrimaryMethod;
  attempts: number;
};

export interface TwoFactorChallengeRepository {
  create(input: TwoFactorChallengeRecord & { tokenHash: string; expiresAt: Date }): Promise<void>;
  /** Unconsumed, unexpired and under the attempt cap; counts this attempt atomically. */
  claimAttempt(input: { tokenHash: string; now: Date; maxAttempts: number }): Promise<TwoFactorChallengeRecord | null>;
  consume(input: { tokenHash: string; now: Date }): Promise<boolean>;
}

export interface CodeHasher {
  hash(code: string): string;
}

export interface TwoFactorAudit {
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

export const CHALLENGE_TTL_MS = 10 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
// Per account, across challenges and IPs: a stolen password can't buy unlimited guesses
// by signing in again. 10 consecutive failures lock the second factor for 15 minutes.
export const MAX_CONSECUTIVE_FAILURES = 10;
export const LOCK_MS = 15 * 60_000;

type Dependencies = {
  records: TwoFactorRepository;
  challenges: TwoFactorChallengeRepository;
  /** Lazily resolved so a missing key only fails the 2FA paths, never the whole API. */
  secretBox: () => SecretBox;
  hasher: CodeHasher;
  audit: TwoFactorAudit;
  organizationRequiresTwoFactor(organizationId: string): Promise<boolean>;
  /** ORG-307 owns session hardening; this is the hook it calls on a 2FA reset. */
  revokeMemberSessions(input: { userId: string; organizationId: string; correlationId: string; reason: string }): Promise<number>;
  ssoPolicy: () => SsoPolicy;
  issuer: string;
  now?: () => Date;
  token?: () => string;
};

const hashToken = (token: string) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

export type CodeInput = { code?: unknown; recoveryCode?: unknown };
type VerifyResult =
  | { kind: "verified"; usedRecoveryCode: boolean; recoveryCodesRemaining: number }
  | { kind: "invalid_code" }
  | { kind: "locked"; retryAfterSeconds: number }
  | { kind: "not_enrolled" };

export const createTwoFactorService = (dependencies: Dependencies) => {
  const now = dependencies.now ?? (() => new Date());
  const newToken = dependencies.token ?? (() => crypto.randomBytes(32).toString("base64url"));
  const context = (userId: string) => `rfpilot:totp:${userId}`;

  const remaining = (record: TwoFactorRecord, justUsed = 0) =>
    record.recoveryCodes.filter((code) => !code.usedAt).length - justUsed;

  const newRecoveryCodes = () => {
    const codes = generateRecoveryCodes();
    return { codes, hashes: codes.map((code) => dependencies.hasher.hash(normalizeRecoveryCode(code))) };
  };

  // Checks a TOTP code or a recovery code against an enabled enrolment.
  const verify = async (userId: string, input: CodeInput): Promise<VerifyResult> => {
    const record = await dependencies.records.find(userId);
    if (!record || record.status !== "enabled") return { kind: "not_enrolled" };
    const at = now();
    if (record.lockedUntil && record.lockedUntil > at) {
      return { kind: "locked", retryAfterSeconds: Math.ceil((record.lockedUntil.getTime() - at.getTime()) / 1000) };
    }
    const fail = async (): Promise<VerifyResult> => {
      await dependencies.records.recordFailure({ userId, now: at, maxFailures: MAX_CONSECUTIVE_FAILURES, lockMs: LOCK_MS });
      return { kind: "invalid_code" };
    };
    if (typeof input.recoveryCode === "string" && input.recoveryCode.trim()) {
      const normalized = normalizeRecoveryCode(input.recoveryCode);
      if (!normalized) return fail();
      const used = await dependencies.records.consumeRecoveryCode({ userId, hash: dependencies.hasher.hash(normalized), now: at });
      return used ? { kind: "verified", usedRecoveryCode: true, recoveryCodesRemaining: remaining(record, 1) } : fail();
    }
    if (typeof input.code !== "string") return fail();
    const secret = dependencies.secretBox().open(record.secretCiphertext, context(userId));
    const step = matchTotpStep(secret, input.code, at);
    // A matched step at or below the last accepted one is a replayed code.
    if (step === null || !await dependencies.records.acceptStep({ userId, step })) return fail();
    return { kind: "verified", usedRecoveryCode: false, recoveryCodesRemaining: remaining(record) };
  };

  const assessSignIn = async (input: { userId: string; organizationId: string; method: PrimaryMethod }) => {
    const [record, required] = await Promise.all([
      dependencies.records.find(input.userId),
      dependencies.organizationRequiresTwoFactor(input.organizationId),
    ]);
    const step = decideSecondFactor({
      enrolled: record?.status === "enabled",
      organizationRequiresTwoFactor: required,
      method: input.method,
      ssoPolicy: dependencies.ssoPolicy(),
    });
    if (step === "none") return { step } as const;
    const challengeToken = newToken();
    const expiresAt = new Date(now().getTime() + CHALLENGE_TTL_MS);
    await dependencies.challenges.create({
      tokenHash: hashToken(challengeToken),
      userId: input.userId,
      organizationId: input.organizationId,
      purpose: step === "challenge" ? "verify" : "enrol",
      method: input.method,
      attempts: 0,
      expiresAt,
    });
    return { step, challengeToken, challengeExpiresAt: expiresAt.getTime() } as const;
  };

  const startEnrolment = async (input: { userId: string; organizationId: string; accountName: string }) => {
    const secret = generateTotpSecret();
    const saved = await dependencies.records.savePending({
      userId: input.userId,
      organizationId: input.organizationId,
      secretCiphertext: dependencies.secretBox().seal(secret, context(input.userId)),
    });
    if (!saved) return { kind: "already_enabled" as const };
    return {
      kind: "started" as const,
      secret,
      otpauthUri: otpauthUri({ issuer: dependencies.issuer, accountName: input.accountName, secret }),
    };
  };

  const confirmEnrolment = async (input: { userId: string; organizationId: string; code: unknown; correlationId: string }) => {
    const record = await dependencies.records.find(input.userId);
    if (!record) return { kind: "not_started" as const };
    if (record.status === "enabled") return { kind: "already_enabled" as const };
    const at = now();
    const secret = dependencies.secretBox().open(record.secretCiphertext, context(input.userId));
    const step = typeof input.code === "string" ? matchTotpStep(secret, input.code, at) : null;
    if (step === null) return { kind: "invalid_code" as const };
    const { codes, hashes } = newRecoveryCodes();
    const enabled = await dependencies.records.enable({
      userId: input.userId, secretCiphertext: record.secretCiphertext, step, recoveryCodeHashes: hashes, now: at,
    });
    if (!enabled) return { kind: "not_started" as const };
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "auth.two_factor.enrolled",
      targetType: "user",
      targetId: input.userId,
      decision: "created",
      reason: "totp_confirmed",
      correlationId: input.correlationId,
    });
    return { kind: "enabled" as const, recoveryCodes: codes };
  };

  const claimChallenge = async (challengeToken: unknown, purpose: "verify" | "enrol") => {
    if (typeof challengeToken !== "string" || !challengeToken) return null;
    const challenge = await dependencies.challenges.claimAttempt({
      tokenHash: hashToken(challengeToken), now: now(), maxAttempts: CHALLENGE_MAX_ATTEMPTS,
    });
    return challenge?.purpose === purpose ? challenge : null;
  };

  const completeChallenge = async (input: CodeInput & { challengeToken: unknown; correlationId: string }) => {
    const challenge = await claimChallenge(input.challengeToken, "verify");
    if (!challenge) return { kind: "invalid_challenge" as const };
    const result = await verify(challenge.userId, input);
    if (result.kind !== "verified") {
      await dependencies.audit.append({
        organizationId: challenge.organizationId,
        actorUserId: challenge.userId,
        action: "auth.two_factor.challenge_failed",
        targetType: "user",
        targetId: challenge.userId,
        decision: "denied",
        reason: result.kind,
        correlationId: input.correlationId,
      });
      return result.kind === "not_enrolled" ? { kind: "invalid_challenge" as const } : result;
    }
    // Single-use: a second completion with the same token gets nothing.
    if (!await dependencies.challenges.consume({ tokenHash: hashToken(String(input.challengeToken)), now: now() })) {
      return { kind: "invalid_challenge" as const };
    }
    if (result.usedRecoveryCode) {
      await dependencies.audit.append({
        organizationId: challenge.organizationId,
        actorUserId: challenge.userId,
        action: "auth.two_factor.recovery_code_used",
        targetType: "user",
        targetId: challenge.userId,
        decision: "allowed",
        reason: "recovery_code_accepted",
        correlationId: input.correlationId,
        metadata: { recoveryCodesRemaining: result.recoveryCodesRemaining },
      });
    }
    return { ...result, userId: challenge.userId, organizationId: challenge.organizationId };
  };

  const startChallengeEnrolment = async (input: { challengeToken: unknown; accountName: (userId: string) => Promise<string> }) => {
    const challenge = await claimChallenge(input.challengeToken, "enrol");
    if (!challenge) return { kind: "invalid_challenge" as const };
    return startEnrolment({ userId: challenge.userId, organizationId: challenge.organizationId, accountName: await input.accountName(challenge.userId) });
  };

  const confirmChallengeEnrolment = async (input: { challengeToken: unknown; code: unknown; correlationId: string }) => {
    const challenge = await claimChallenge(input.challengeToken, "enrol");
    if (!challenge) return { kind: "invalid_challenge" as const };
    const result = await confirmEnrolment({ userId: challenge.userId, organizationId: challenge.organizationId, code: input.code, correlationId: input.correlationId });
    if (result.kind !== "enabled") return result;
    if (!await dependencies.challenges.consume({ tokenHash: hashToken(String(input.challengeToken)), now: now() })) {
      return { kind: "invalid_challenge" as const };
    }
    return { ...result, userId: challenge.userId, organizationId: challenge.organizationId };
  };

  /** The caller has already re-checked the password; this adds a current second factor. */
  const disable = async (input: CodeInput & { userId: string; organizationId: string; correlationId: string }) => {
    if (await dependencies.organizationRequiresTwoFactor(input.organizationId)) return { kind: "required_by_organization" as const };
    const result = await verify(input.userId, input);
    if (result.kind !== "verified") return result;
    await dependencies.records.remove(input.userId);
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "auth.two_factor.disabled",
      targetType: "user",
      targetId: input.userId,
      decision: "revoked",
      reason: "user_disabled_with_reauthentication",
      correlationId: input.correlationId,
    });
    return { kind: "disabled" as const };
  };

  const regenerateRecoveryCodes = async (input: CodeInput & { userId: string; organizationId: string; correlationId: string }) => {
    const result = await verify(input.userId, input);
    if (result.kind !== "verified") return result;
    const { codes, hashes } = newRecoveryCodes();
    await dependencies.records.replaceRecoveryCodes({ userId: input.userId, hashes });
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "auth.two_factor.recovery_codes_regenerated",
      targetType: "user",
      targetId: input.userId,
      decision: "created",
      reason: "user_requested",
      correlationId: input.correlationId,
    });
    return { kind: "regenerated" as const, recoveryCodes: codes };
  };

  /** ORG-304: an Admin clears a member's 2FA. The member re-enrols on next sign-in if required. */
  const adminReset = async (input: { actorUserId: string; targetUserId: string; organizationId: string; correlationId: string }) => {
    const removed = await dependencies.records.remove(input.targetUserId);
    const revokedSessions = await dependencies.revokeMemberSessions({
      userId: input.targetUserId,
      organizationId: input.organizationId,
      correlationId: input.correlationId,
      reason: "two_factor_reset",
    });
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "auth.two_factor.reset",
      targetType: "user",
      targetId: input.targetUserId,
      decision: "revoked",
      reason: removed ? "admin_reset" : "admin_reset_not_enrolled",
      correlationId: input.correlationId,
      metadata: { revokedSessions },
    });
    return { kind: "reset" as const, wasEnrolled: removed, revokedSessions };
  };

  const status = async (input: { userId: string; organizationId: string }) => {
    const [record, required] = await Promise.all([
      dependencies.records.find(input.userId),
      dependencies.organizationRequiresTwoFactor(input.organizationId),
    ]);
    return {
      enabled: record?.status === "enabled",
      pendingEnrolment: record?.status === "pending",
      recoveryCodesRemaining: record?.status === "enabled" ? remaining(record) : 0,
      requiredByOrganization: required,
    };
  };

  return {
    assessSignIn,
    startEnrolment,
    confirmEnrolment,
    completeChallenge,
    startChallengeEnrolment,
    confirmChallengeEnrolment,
    disable,
    regenerateRecoveryCodes,
    adminReset,
    status,
  };
};

export type TwoFactorService = ReturnType<typeof createTwoFactorService>;
