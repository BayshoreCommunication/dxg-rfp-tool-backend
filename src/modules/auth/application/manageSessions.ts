import crypto from "node:crypto";
import type {
  RefreshSessionRepository,
  SecurityAuditWriter,
  SessionAccessTokenIssuer,
  SessionAccount,
  SessionAccountLoader,
} from "../domain/ports/sessionPorts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * DAY_MS;

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
    correlationId: string;
    userAgent?: string;
    ip?: string;
  }): Promise<
    | { kind: "rotated"; accessToken: string; expiresAt: number; expiresIn: number; refreshToken: string; refreshExpiresAt: number; sessionId: string }
    | { kind: "invalid" | "expired" | "reuse_detected" | "membership_inactive" }
  > => {
    const issuedAt = now();
    const stored = await dependencies.sessions.findByTokenHash(hashOpaqueToken(input.refreshToken));
    if (!stored) return { kind: "invalid" };
    if (stored.status !== "active") {
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
      return { kind: "reuse_detected" };
    }
    if (stored.expiresAt <= issuedAt || stored.idleExpiresAt <= issuedAt) {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: "refresh_expired", now: issuedAt });
      return { kind: "expired" };
    }
    const consumed = await dependencies.sessions.consumeActive({ id: stored.id, now: issuedAt });
    if (!consumed) {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: "refresh_race_or_reuse", now: issuedAt });
      return { kind: "reuse_detected" };
    }
    const account = await dependencies.accounts.load(stored.userId, stored.organizationId);
    if (!account) {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: "membership_inactive", now: issuedAt });
      return { kind: "membership_inactive" };
    }
    const refreshToken = opaqueToken();
    const tokenId = id();
    const idleExpiresAt = new Date(
      Math.min(
        deadline(issuedAt, refreshTokenTtlMs).getTime(),
        stored.expiresAt.getTime(),
      ),
    );
    await dependencies.sessions.create({
      organizationId: stored.organizationId,
      userId: stored.userId,
      sessionId: stored.sessionId,
      familyId: stored.familyId,
      tokenId,
      tokenHash: hashOpaqueToken(refreshToken),
      parentTokenId: stored.tokenId,
      expiresAt: stored.expiresAt,
      idleExpiresAt,
      now: issuedAt,
      userAgentHash: hashClientMetadata(input.userAgent),
      ipHash: hashClientMetadata(input.ip),
    });
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
