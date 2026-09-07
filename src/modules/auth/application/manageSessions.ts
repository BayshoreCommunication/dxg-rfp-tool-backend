import crypto from "node:crypto";
import type {
  RefreshSessionRepository,
  SecurityAuditWriter,
  SessionAccessTokenIssuer,
  SessionAccount,
  SessionAccountLoader,
  StoredRefreshToken,
} from "../domain/ports/sessionPorts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * DAY_MS;
export const REFRESH_HANDOFF_MS = 30_000;
const REFRESH_CLOCK_SKEW_MS = 5_000;
// Never discard replay hashes. End an abnormally busy family before its
// history can approach Mongo's document limit (normal 30d/15m = 2880).
export const MAX_SESSION_ROTATIONS = 10_000;

export const hashOpaqueToken = (token: string): string =>
  crypto.createHash("sha256").update(token, "utf8").digest("hex");
export const generateOpaqueToken = (): string => crypto.randomBytes(32).toString("base64url");
export const hashClientMetadata = (value?: string): string | undefined =>
  value?.trim() ? hashOpaqueToken(value.trim()) : undefined;

type Dependencies = {
  sessions: RefreshSessionRepository;
  accounts: SessionAccountLoader;
  accessTokens: SessionAccessTokenIssuer;
  audit: SecurityAuditWriter;
  now?: () => Date;
  opaqueToken?: () => string;
  id?: () => string;
  refreshTokenTtlMs?: number;
  deriveRefreshToken?: (previous: string, operationKey: string) => string;
};

const deadline = (base: Date, ms: number) => new Date(base.getTime() + ms);

export const createSessionManager = (dependencies: Dependencies) => {
  const now = dependencies.now ?? (() => new Date());
  const opaqueToken = dependencies.opaqueToken ?? generateOpaqueToken;
  const id = dependencies.id ?? crypto.randomUUID;
  const refreshTokenTtlMs =
    dependencies.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS;

  const begin = async (input: {
    account: SessionAccount;
    correlationId: string;
    userAgent?: string;
    ip?: string;
  }) => {
    const issuedAt = now();
    const refreshToken = opaqueToken();
    const sessionId = id();
    const familyId = id();
    const tokenId = id();
    const expiresAt = deadline(issuedAt, refreshTokenTtlMs);
    const idleExpiresAt = deadline(issuedAt, refreshTokenTtlMs);
    await dependencies.sessions.create({
      organizationId: input.account.organizationId,
      userId: input.account.userId,
      sessionId,
      familyId,
      tokenId,
      tokenHash: hashOpaqueToken(refreshToken),
      expiresAt,
      idleExpiresAt,
      now: issuedAt,
      userAgentHash: hashClientMetadata(input.userAgent),
      ipHash: hashClientMetadata(input.ip),
    });
    await dependencies.audit.append({
      organizationId: input.account.organizationId,
      actorUserId: input.account.userId,
      action: "auth.session.created",
      targetType: "refresh_session",
      targetId: sessionId,
      decision: "created",
      reason: "authentication_succeeded",
      correlationId: input.correlationId,
    });
    return {
      ...dependencies.accessTokens.issue(input.account, sessionId),
      refreshToken,
      refreshExpiresAt: expiresAt.getTime(),
      sessionId,
    };
  };

  const rotate = async (input: {
    refreshToken: string;
    /** Only the trusted BFF may supply a stable, secret-derived operation key. */
    rotationKey?: string;
    correlationId: string;
    userAgent?: string;
    ip?: string;
  }): Promise<
    | { kind: "rotated"; accessToken: string; expiresAt: number; expiresIn: number; refreshToken: string; refreshExpiresAt: number; sessionId: string }
    | { kind: "invalid" | "expired" | "reuse_detected" | "membership_inactive" }
  > => {
    const issuedAt = now();
    const presentedHash = hashOpaqueToken(input.refreshToken);
    const stored = await dependencies.sessions.findByTokenHash(presentedHash);
    if (!stored) return { kind: "invalid" };
    const key = input.rotationKey && /^[a-f0-9]{64}$/.test(input.rotationKey) && dependencies.deriveRefreshToken ? input.rotationKey : undefined;
    const keyHash = key ? hashOpaqueToken(key) : null;
    const rejectReuse = async () => {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: "refresh_reuse", now: issuedAt });
      await dependencies.audit.append({
        organizationId: stored.organizationId,
        actorUserId: stored.userId,
        action: "auth.refresh.reuse_detected",
        targetType: "refresh_session",
        targetId: stored.sessionId,
        decision: "detected",
        reason: "consumed_or_revoked_token_presented",
        correlationId: input.correlationId,
      });
      return { kind: "reuse_detected" as const };
    };
    const recoverHandoff = async (current: StoredRefreshToken | null) => {
      const retryAt = now();
      const rotation = current?.lastRotation;
      if (!current || current.status !== 'active' || !key || !rotation ||
        rotation.previousHash !== presentedHash || rotation.keyHash !== keyHash ||
        retryAt.getTime() < rotation.at.getTime() - REFRESH_CLOCK_SKEW_MS || retryAt.getTime() - rotation.at.getTime() >= REFRESH_HANDOFF_MS ||
        current.expiresAt <= retryAt || current.idleExpiresAt <= retryAt) return rejectReuse();
      const refreshToken = dependencies.deriveRefreshToken!(input.refreshToken, key);
      // Only the immediate, still-current successor is recoverable. Neither a
      // second rotation nor logout can be undone by a delayed response.
      if (current.tokenHash !== hashOpaqueToken(refreshToken)) return rejectReuse();
      const account = await dependencies.accounts.load(current.userId, current.organizationId);
      if (!account) {
        await dependencies.sessions.revokeFamily({ familyId: current.familyId, reason: 'membership_inactive', now: issuedAt });
        return { kind: 'membership_inactive' as const };
      }
      return { kind: 'rotated' as const, ...dependencies.accessTokens.issue(account, current.sessionId), refreshToken,
        refreshExpiresAt: current.expiresAt.getTime(), sessionId: current.sessionId };
    };
    if (stored.status !== 'active' || stored.tokenHash !== presentedHash) return recoverHandoff(stored);
    if (stored.expiresAt <= issuedAt || stored.idleExpiresAt <= issuedAt) {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: "refresh_expired", now: issuedAt });
      return { kind: "expired" };
    }
    if (stored.rotationCount >= MAX_SESSION_ROTATIONS) {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: 'refresh_rotation_limit', now: issuedAt });
      await dependencies.audit.append({ organizationId: stored.organizationId, actorUserId: stored.userId,
        action: 'auth.session.revoked', targetType: 'refresh_session', targetId: stored.sessionId,
        decision: 'revoked', reason: 'refresh_rotation_limit', correlationId: input.correlationId });
      return { kind: 'expired' };
    }
    const account = await dependencies.accounts.load(stored.userId, stored.organizationId);
    if (!account) {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: "membership_inactive", now: issuedAt });
      return { kind: "membership_inactive" };
    }
    const refreshToken = key ? dependencies.deriveRefreshToken!(input.refreshToken, key) : opaqueToken();
    const tokenId = id();
    const rotated = await dependencies.sessions.rotateActive({
      id: stored.id, previousHash: presentedHash, tokenHash: hashOpaqueToken(refreshToken),
      tokenId, keyHash, now: now(), maxRotations: MAX_SESSION_ROTATIONS,
    });
    if (!rotated) return recoverHandoff(await dependencies.sessions.findByTokenHash(presentedHash));
    await dependencies.audit.append({
      organizationId: stored.organizationId,
      actorUserId: stored.userId,
      action: "auth.refresh.rotated",
      targetType: "refresh_session",
      targetId: stored.sessionId,
      decision: "allowed",
      reason: "active_refresh_rotated",
      correlationId: input.correlationId,
    });
    return {
      kind: "rotated",
      ...dependencies.accessTokens.issue(account, stored.sessionId),
      refreshToken,
      refreshExpiresAt: stored.expiresAt.getTime(),
      sessionId: stored.sessionId,
    };
  };

  const revokeSession = async (input: {
    userId: string;
    organizationId: string;
    sessionId: string;
    correlationId: string;
    reason?: string;
  }) => {
    const revoked = await dependencies.sessions.revokeSession({
      userId: input.userId,
      sessionId: input.sessionId,
      reason: input.reason ?? "user_logout",
      now: now(),
    });
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "auth.session.revoked",
      targetType: "refresh_session",
      targetId: input.sessionId,
      decision: "revoked",
      reason: input.reason ?? "user_logout",
      correlationId: input.correlationId,
    });
    return revoked;
  };

  const revokePresented = async (input: {
    refreshToken: string;
    correlationId: string;
    reason?: string;
  }) => {
    const stored = await dependencies.sessions.findByTokenHash(
      hashOpaqueToken(input.refreshToken),
    );
    if (!stored) return { kind: "not_found" as const, revoked: 0 };

    const reason = input.reason ?? "user_logout";
    const revoked = await dependencies.sessions.revokeSession({
      userId: stored.userId,
      sessionId: stored.sessionId,
      reason,
      now: now(),
    });
    if (revoked > 0) {
      await dependencies.audit.append({
        organizationId: stored.organizationId,
        actorUserId: stored.userId,
        action: "auth.session.revoked",
        targetType: "refresh_session",
        targetId: stored.sessionId,
        decision: "revoked",
        reason,
        correlationId: input.correlationId,
      });
    }
    return { kind: "revoked" as const, revoked };
  };

  const revokeAll = async (input: {
    userId: string;
    organizationId: string;
    correlationId: string;
    reason?: string;
  }) => {
    const revoked = await dependencies.sessions.revokeAll({
      userId: input.userId,
      organizationId: input.organizationId,
      reason: input.reason ?? "user_logout_all",
      now: now(),
    });
    await dependencies.audit.append({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "auth.sessions.revoked_all",
      targetType: "user",
      targetId: input.userId,
      decision: "revoked",
      reason: input.reason ?? "user_logout_all",
      correlationId: input.correlationId,
      metadata: { revokedCount: revoked },
    });
    return revoked;
  };

  const listActive = (input: { userId: string; organizationId: string }) =>
    dependencies.sessions.listActive({ ...input, now: now() });

  return {
    begin,
    rotate,
    revokeSession,
    revokePresented,
    revokeAll,
    listActive,
  };
};
