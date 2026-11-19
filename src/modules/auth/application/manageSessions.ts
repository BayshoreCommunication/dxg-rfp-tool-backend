import crypto from "node:crypto";
import type {
  RefreshSessionRepository,
  SecurityAuditWriter,
  SessionAccessTokenIssuer,
  SessionAccount,
  SessionAccountLoader,
  StoredRefreshToken,
} from "../domain/ports/sessionPorts";
import { STAFF_MEMBERSHIP_REVOKE_REASON, isStaffCausedRevokeReason } from "../domain/ports/sessionPorts";
import { ORGANIZATION_BLOCK_REVOKE_REASON } from "../../organizationBlock/domain";

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
  /** The revoke reason for a member who is no longer active; "membership_inactive" when not given. */
  inactiveMembershipReason?: (member: { userId: string; organizationId: string }) => Promise<string>;
  /** The organization block gate (organizationBlock/organizationBlockGate.ts). When it answers
      true no session is begun or refreshed for that organization. Not given: nothing is blocked. */
  organizationBlocked?: (organizationId: string) => Promise<boolean>;
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
    | { kind: "invalid" | "expired" | "reuse_detected" | "membership_inactive" | "organization_blocked" }
  > => {
    const issuedAt = now();
    const presentedHash = hashOpaqueToken(input.refreshToken);
    const stored = await dependencies.sessions.findByTokenHash(presentedHash);
    if (!stored) return { kind: "invalid" };
    /* RFPilot staff blocked the organization (organizationBlock/domain.ts): no refresh.

       WHO IS TOLD. Only a refresh that would otherwise have been GRANTED answers
       `organization_blocked`: the two places below that issue tokens ask the gate last, after
       every refusal of their own (`refuseBlocked`). So a dead credential (a consumed token, a
       logged-out or otherwise revoked session, an expired one, a member who is no longer active)
       gets exactly the answer, the revocation and the audit event it always got, and does not
       learn of the block. One more state is a live credential: the session the BLOCK ITSELF
       ended, presenting its own current token while the organization is still blocked. Without
       the block it would have refreshed, so it is told too (`endedByBlock`).

       Nothing is written to the organization's audit trail for a block (customers see no staff
       activity): the family ends for the block's reason, unaudited. A failed gate lookup
       rejects, which the caller answers as a retryable 503 without clearing the cookie. */
    const blockedNow = async () => (await dependencies.organizationBlocked?.(stored.organizationId)) === true;
    const refuseBlocked = async () => {
      if (!(await blockedNow())) return null;
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: ORGANIZATION_BLOCK_REVOKE_REASON, now: issuedAt });
      return { kind: "organization_blocked" as const };
    };
    const endedByBlock = stored.status === "revoked" && stored.revokeReason === ORGANIZATION_BLOCK_REVOKE_REASON &&
      stored.tokenHash === presentedHash && stored.expiresAt > issuedAt && stored.idleExpiresAt > issuedAt;
    if (endedByBlock && (await blockedNow()) && (await dependencies.accounts.load(stored.userId, stored.organizationId))) {
      return { kind: "organization_blocked" };
    }
    const key = input.rotationKey && /^[a-f0-9]{64}$/.test(input.rotationKey) && dependencies.deriveRefreshToken ? input.rotationKey : undefined;
    const keyHash = key ? hashOpaqueToken(key) : null;
    // The reason is read before the revocation, and a failed read must not skip the revocation:
    // the family is then ended for the staff reason, so nothing can reach the member's organization.
    const inactiveReason = async (member: StoredRefreshToken) => {
      try {
        return (await dependencies.inactiveMembershipReason?.(member)) ?? "membership_inactive";
      } catch (failure) {
        console.error("Session revocation error: the cause of an inactive membership could not be read:", failure instanceof Error ? failure.message : failure);
        return STAFF_MEMBERSHIP_REVOKE_REASON;
      }
    };
    const rejectReuse = async (current: StoredRefreshToken | null = stored) => {
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: "refresh_reuse", now: issuedAt });
      // Staff ended this session and its own last token came back: refused the same, not recorded here.
      if (current?.status === "revoked" && isStaffCausedRevokeReason(current.revokeReason) && current.tokenHash === presentedHash) return { kind: "reuse_detected" as const };
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
      /* The block ended this session just after a keyed rotation, and the retry of THAT rotation
         arrives: the previous token, the same key, inside the hand-off window, its successor
         still the current token. Without the block this request answers `rotated` and writes no
         row, so the block must not cause one (`rejectReuse` below would record a reuse in the
         customer organization). Told like any live credential while the organization is still
         blocked and the account loads; otherwise refused as the dead session it is. No audit row
         and no token either way; the family is already ended for the block's reason. Only for
         the block's reason: a session ended for any other reason takes the path below. */
      if (current && key && rotation && current.status === 'revoked' && current.revokeReason === ORGANIZATION_BLOCK_REVOKE_REASON &&
        rotation.previousHash === presentedHash && rotation.keyHash === keyHash &&
        retryAt.getTime() >= rotation.at.getTime() - REFRESH_CLOCK_SKEW_MS && retryAt.getTime() - rotation.at.getTime() < REFRESH_HANDOFF_MS &&
        current.expiresAt > retryAt && current.idleExpiresAt > retryAt &&
        current.tokenHash === hashOpaqueToken(dependencies.deriveRefreshToken!(input.refreshToken, key))) {
        return (await blockedNow()) && (await dependencies.accounts.load(current.userId, current.organizationId))
          ? { kind: 'organization_blocked' as const } : { kind: 'reuse_detected' as const };
      }
      if (!current || current.status !== 'active' || !key || !rotation ||
        rotation.previousHash !== presentedHash || rotation.keyHash !== keyHash ||
        retryAt.getTime() < rotation.at.getTime() - REFRESH_CLOCK_SKEW_MS || retryAt.getTime() - rotation.at.getTime() >= REFRESH_HANDOFF_MS ||
        current.expiresAt <= retryAt || current.idleExpiresAt <= retryAt) return rejectReuse(current);
      const refreshToken = dependencies.deriveRefreshToken!(input.refreshToken, key);
      // Only the immediate, still-current successor is recoverable. Neither a
      // second rotation nor logout can be undone by a delayed response.
      if (current.tokenHash !== hashOpaqueToken(refreshToken)) return rejectReuse(current);
      const account = await dependencies.accounts.load(current.userId, current.organizationId);
      if (!account) {
        await dependencies.sessions.revokeFamily({ familyId: current.familyId, reason: await inactiveReason(current), now: issuedAt });
        return { kind: 'membership_inactive' as const };
      }
      // A recoverable handoff is a live credential: asked last, as on the direct path below.
      const refusedForBlock = await refuseBlocked();
      if (refusedForBlock) return refusedForBlock;
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
      await dependencies.sessions.revokeFamily({ familyId: stored.familyId, reason: await inactiveReason(stored), now: issuedAt });
      return { kind: "membership_inactive" };
    }
    // Everything of its own is decided; this refresh would be granted. Is the organization blocked?
    const refusedForBlock = await refuseBlocked();
    if (refusedForBlock) return refusedForBlock;
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
    // Only a session that was actually revoked is audited (as revokePresented does). The id
    // comes from the request, so an unknown or foreign one must not be recorded as "revoked".
    if (revoked > 0) {
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
    }
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

  // The access path calls this on every request from a member who is no longer active, so it
  // stays idempotent: only the request that actually revokes sessions writes the audit event.
  // Also used for an account waiting for DXG to place it (reason organization_setup_required).
  const revokeInactiveMembership = async (input: { userId: string; organizationId: string; correlationId: string; reason?: string }) => {
    const reason = input.reason ?? "membership_inactive";
    const revoked = await dependencies.sessions.revokeAll({
      userId: input.userId,
      organizationId: input.organizationId,
      reason,
      now: now(),
    });
    if (revoked > 0) {
      await dependencies.audit.append({
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: "auth.sessions.revoked_all",
        targetType: "user",
        targetId: input.userId,
        decision: "revoked",
        reason,
        correlationId: input.correlationId,
        metadata: { revokedCount: revoked },
      });
    }
    return revoked;
  };

  // ORG-307: a membership change (role, deactivation, 2FA reset) ends the member's other
  // sessions. exceptSessionId is the session that keeps working, when there is one.
  const revokeOtherSessions = async (input: {
    userId: string; organizationId: string; exceptSessionId?: string; reason: string;
    actorUserId?: string; correlationId: string;
  }) => {
    const revoked = await dependencies.sessions.revokeAll({
      userId: input.userId, organizationId: input.organizationId, reason: input.reason, now: now(),
      exceptSessionId: input.exceptSessionId,
    });
    if (revoked > 0) {
      await dependencies.audit.append({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? input.userId,
        action: "auth.sessions.revoked_others",
        targetType: "user",
        targetId: input.userId,
        decision: "revoked",
        reason: input.reason,
        correlationId: input.correlationId,
        metadata: { revokedCount: revoked, keptSession: Boolean(input.exceptSessionId) },
      });
    }
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
    revokeInactiveMembership,
    revokeOtherSessions,
    listActive,
  };
};
