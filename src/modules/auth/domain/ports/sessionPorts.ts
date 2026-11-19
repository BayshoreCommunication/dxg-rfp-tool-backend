import { ORGANIZATION_BLOCK_REVOKE_REASON } from "../../../organizationBlock/domain";

export type AccountType = "planner" | "admin";

export type SessionAccount = {
  userId: string;
  accountType: AccountType;
  email: string;
  organizationId: string;
  role: string;
  roles: string[];
  rolesVersion: number;
};

export type StoredRefreshToken = {
  id: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  familyId: string;
  tokenId: string;
  tokenHash: string;
  rotationCount: number;
  lastRotation?: { previousHash: string; keyHash: string | null; at: Date } | null;
  status: "active" | "consumed" | "revoked";
  /** Why a revoked session was revoked (see STAFF_MEMBERSHIP_REVOKE_REASON). */
  revokeReason?: string | null;
  expiresAt: Date;
  idleExpiresAt: Date;
};

/* The revoke reason of a session that ended because RFPILOT STAFF changed the member's membership
   (role, deactivation, ownership transfer; owner decision 2026-11-18, docs/DECISIONS.md). It is
   data set by the staff flow only. A session revoked for this reason was not stolen: when its own
   last refresh token is presented again the refresh is refused as always, and no "reuse detected"
   event is written in the member's organization, where staff activity is never shown. */
export const STAFF_MEMBERSHIP_REVOKE_REASON = "staff_membership_changed";

/* Every revoke reason that means "RFPilot staff caused this": a staff membership change, or a
   staff block of the whole organization (owner decision 2026-11-18, organizationBlock/domain.ts).
   One rule for both: such a session's own last token coming back is refused and not recorded in
   the member's organization. */
export const isStaffCausedRevokeReason = (reason: string | null | undefined): boolean =>
  reason === STAFF_MEMBERSHIP_REVOKE_REASON || reason === ORGANIZATION_BLOCK_REVOKE_REASON;

export interface RefreshSessionRepository {
  create(input: {
    organizationId: string;
    userId: string;
    sessionId: string;
    familyId: string;
    tokenId: string;
    tokenHash: string;
    parentTokenId?: string;
    expiresAt: Date;
    idleExpiresAt: Date;
    now: Date;
    userAgentHash?: string;
    ipHash?: string;
  }): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<StoredRefreshToken | null>;
  rotateActive(input: {
    id: string; previousHash: string; tokenHash: string; tokenId: string;
    keyHash: string | null; now: Date; maxRotations: number;
  }): Promise<boolean>;
  revokeFamily(input: { familyId: string; reason: string; now: Date }): Promise<number>;
  revokeSession(input: { sessionId: string; userId: string; reason: string; now: Date }): Promise<number>;
  // exceptSessionId keeps one session (the acting one) alive.
  revokeAll(input: { userId: string; organizationId: string; reason: string; now: Date; exceptSessionId?: string }): Promise<number>;
  listActive(input: { userId: string; organizationId: string; now: Date }): Promise<Array<{
    sessionId: string;
    createdAt: Date;
    lastUsedAt: Date;
    expiresAt: Date;
    userAgentHash?: string | null;
    ipHash?: string | null;
  }>>;
}

export interface SessionAccountLoader {
  load(userId: string, organizationId: string): Promise<SessionAccount | null>;
}

export interface SessionAccessTokenIssuer {
  issue(account: SessionAccount, sessionId: string): {
    accessToken: string;
    expiresAt: number;
    expiresIn: number;
  };
}

export interface SecurityAuditWriter {
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
