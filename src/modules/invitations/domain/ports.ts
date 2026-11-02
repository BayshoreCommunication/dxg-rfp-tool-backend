import type { InvitableRole, InvitationStatus } from "./invitationRules";

export type DeliveryKind = "invite" | "resend" | "reminder";
export type DeliveryState = "pending" | "sending" | "sent" | "failed";

export type InvitationRecord = {
  id: string;
  organizationId: string;
  email: string;
  role: InvitableRole;
  teamId: string | null;
  invitedBy: string;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  delivery: { state: DeliveryState; kind: DeliveryKind; attempts: number; sentAt: Date | null };
};

export interface InvitationRepository {
  // Refuses a second pending invitation for the same email in the organization.
  insertPending(input: {
    organizationId: string;
    email: string;
    role: InvitableRole;
    teamId: string | null;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<{ kind: "created"; invitation: InvitationRecord } | { kind: "duplicate" }>;
  findById(organizationId: string, id: string): Promise<InvitationRecord | null>;
  list(organizationId: string, filter: { status?: InvitationStatus }): Promise<InvitationRecord[]>;
  pendingEmails(organizationId: string, emails: readonly string[], now: Date): Promise<Set<string>>;
  // The invitation a presented token hash points at, and whether it's the current link.
  findByTokenHash(tokenHash: string): Promise<{ invitation: InvitationRecord; current: boolean } | null>;
  // Kills the current link at once, extends the expiry and queues a fresh email.
  prepareResend(organizationId: string, id: string, input: { now: Date; expiresAt: Date }): Promise<InvitationRecord | null>;
  revoke(organizationId: string, id: string, input: { by: string; now: Date }): Promise<InvitationRecord | null>;
  // Claims the invitation for one delivery attempt and swaps in a new link in the same write.
  claimDelivery(id: string, input: { now: Date; leaseUntil: Date; tokenHash: string; maxAttempts: number }): Promise<InvitationRecord | null>;
  completeDelivery(id: string, input: { now: Date; outcome: "sent" | "failed"; tokenHash: string }): Promise<void>;
}

// Where an email stands relative to the inviting organization. No entry means no account yet.
export type InviteeStanding = {
  userId: string;
  blocked: boolean;
  membershipHere: "invited" | "active" | "suspended" | "removed" | null;
  activeElsewhere: boolean;
  inLegacyHolding: boolean;
};

export interface InviteeDirectory {
  standings(organizationId: string, emails: readonly string[]): Promise<Map<string, InviteeStanding>>;
}

export type OrganizationSummary = { id: string; name: string; allowManagerInvites: boolean; invitable: boolean };

export interface OrganizationDirectory {
  find(organizationId: string): Promise<OrganizationSummary | null>;
  userName(userId: string): Promise<string | null>;
}

// Teams arrive with ORG-201. Until that model is on main the directory can't verify a team, so
// the invitation stores the id and the manager check runs on the actor's managed team ids.
export interface InvitationTeamDirectory {
  findTeams(organizationId: string, teamIds: readonly string[]): Promise<Map<string, { id: string; name: string | null }>>;
}

export type JoinResult =
  | { kind: "joined"; userId: string }
  | { kind: "stale" }
  | { kind: "account_exists" }
  | { kind: "refused"; code: "ALREADY_MEMBER" | "EMAIL_IN_ANOTHER_ORGANIZATION" | "LEGACY_ACCOUNT_PENDING_PLACEMENT" };

// One transaction: the membership, the user's organization, the team placement and the
// invitation's single use all land together or not at all.
export interface InvitationAcceptanceStore {
  joinExistingAccount(input: {
    invitationId: string;
    tokenHash: string;
    userId: string;
    now: Date;
  }): Promise<JoinResult>;
  joinNewAccount(input: {
    invitationId: string;
    tokenHash: string;
    name: string;
    phone?: string;
    passwordHash: string;
    now: Date;
  }): Promise<JoinResult>;
}

export interface InviteeCredentials {
  findCredentials(email: string): Promise<{ user: { id: string; name: string; email: string }; passwordHash: string; isBlocked: boolean } | null>;
  emailExists(email: string): Promise<boolean>;
}

export type InvitationEmail = {
  kind: DeliveryKind;
  to: string;
  organizationName: string;
  inviterName: string | null;
  role: InvitableRole;
  teamName: string | null;
  acceptUrl: string;
  expiresAt: Date;
};

export interface InvitationMailer {
  send(email: InvitationEmail): Promise<void>;
}

export interface InvitationAuditWriter {
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
