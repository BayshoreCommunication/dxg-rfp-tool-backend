export type SessionAccount = {
  userId: string;
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
  status: "active" | "consumed" | "revoked";
  expiresAt: Date;
  idleExpiresAt: Date;
};

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
  consumeActive(input: { id: string; now: Date }): Promise<boolean>;
  revokeFamily(input: { familyId: string; reason: string; now: Date }): Promise<number>;
  revokeSession(input: { sessionId: string; userId: string; reason: string; now: Date }): Promise<number>;
  revokeAll(input: { userId: string; organizationId: string; reason: string; now: Date }): Promise<number>;
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
