import {
  DEFAULT_DAILY_INVITATION_EMAIL_LIMIT,
  INVITATION_TTL_MS,
  MAX_BULK_INVITATIONS,
  RESEND_COOLDOWN_MS,
  hashInvitationToken,
  inviteRefusal,
  isInvitableRole,
  isValidEmail,
  looksLikeInvitationToken,
  mayManageInvitation,
  normalizeEmail,
  parseEmailList,
  tokenRefusal,
  type InvitableRole,
  type InvitationStatus,
  type InviteRefusal,
  type InvitingActor,
  type TokenRefusal,
} from "../domain/invitationRules";
import type { GoogleIdentityVerifier, VerifiedGoogleIdentity } from "../../auth/domain/ports/googleIdentityPorts";
import type {
  InvitationAcceptanceStore,
  InvitationAuditWriter,
  InvitationEmailQuota,
  InvitationRecord,
  InvitationRepository,
  InvitationTeamDirectory,
  InviteeCredentials,
  InviteeDirectory,
  InviteeStanding,
  OrganizationDirectory,
} from "../domain/ports";
import type { InvitationDispatcher } from "./dispatchInvitations";

export type RowRefusal =
  | InviteRefusal
  | "INVALID_EMAIL"
  | "DUPLICATE_IN_LIST"
  | "ALREADY_INVITED"
  | "ALREADY_MEMBER"
  | "MEMBER_DEACTIVATED"
  | "EMAIL_IN_ANOTHER_ORGANIZATION"
  | "LEGACY_ACCOUNT_PENDING_PLACEMENT"
  | "TEAM_NOT_FOUND";

export const ROW_REFUSAL_MESSAGES: Record<RowRefusal, string> = {
  INVITE_NOT_ALLOWED: "You don't have permission to invite people to this organization.",
  MANAGER_INVITES_DISABLED: "Your organization doesn't allow Team Managers to invite people.",
  ROLE_NOT_ALLOWED: "You can't invite someone with this role.",
  TEAM_REQUIRED: "Choose one of your teams for this invitation.",
  TEAM_NOT_MANAGED: "You can only invite people into teams you manage.",
  TEAM_NOT_FOUND: "That team doesn't exist in this organization.",
  INVALID_EMAIL: "This isn't a valid email address.",
  DUPLICATE_IN_LIST: "This email appears earlier in the list.",
  ALREADY_INVITED: "This email already has an open invitation. Resend it instead.",
  ALREADY_MEMBER: "This person is already a member of the organization.",
  MEMBER_DEACTIVATED: "This person is a deactivated member. Reactivate them instead of inviting.",
  EMAIL_IN_ANOTHER_ORGANIZATION: "This email belongs to a member of another organization and can't be invited.",
  LEGACY_ACCOUNT_PENDING_PLACEMENT: "This account is waiting to be placed by DXG and can't be invited yet.",
};

export type InvitationView = {
  id: string;
  email: string;
  role: InvitableRole;
  teamId: string | null;
  invitedBy: string;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  emailDelivery: "queued" | "sending" | "sent" | "failed";
};

// A pending invitation past its expiry is expired, whether or not the sweep has marked it yet.
const effectiveStatus = (invitation: InvitationRecord, now: Date): InvitationStatus =>
  invitation.status === "pending" && invitation.expiresAt.getTime() <= now.getTime() ? "expired" : invitation.status;

export const toInvitationView = (invitation: InvitationRecord, now: Date): InvitationView => ({
  id: invitation.id,
  email: invitation.email,
  role: invitation.role,
  teamId: invitation.teamId,
  invitedBy: invitation.invitedBy,
  status: effectiveStatus(invitation, now),
  expiresAt: invitation.expiresAt.toISOString(),
  createdAt: invitation.createdAt.toISOString(),
  acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  revokedAt: invitation.revokedAt?.toISOString() ?? null,
  emailDelivery: invitation.delivery.state === "pending" ? "queued" : invitation.delivery.state,
});

const standingRefusal = (standing: InviteeStanding | undefined): RowRefusal | null => {
  if (!standing) return null;
  if (standing.inLegacyHolding) return "LEGACY_ACCOUNT_PENDING_PLACEMENT";
  if (standing.membershipHere === "active") return "ALREADY_MEMBER";
  if (standing.membershipHere === "suspended") return "MEMBER_DEACTIVATED";
  if (standing.activeElsewhere) return "EMAIL_IN_ANOTHER_ORGANIZATION";
  return null;
};

const objectIdPattern = /^[a-f0-9]{24}$/i;

type CreateInput = { role?: unknown; teamId?: unknown };

export type BulkRow =
  | { row: number; email: string; outcome: "invited"; invitation: InvitationView }
  | { row: number; email: string; outcome: "refused"; code: RowRefusal; message: string };

export type DailyLimitReached = {
  kind: "limited";
  code: "INVITATION_DAILY_LIMIT";
  message: string;
  remaining: number;
  retryAfterSeconds: number;
};

export type CreateOutcome =
  | { kind: "validation"; code: "INVALID_ROLE" | "INVALID_TEAM" | "NO_EMAILS" | "TOO_MANY_EMAILS"; message: string }
  | { kind: "forbidden"; code: InviteRefusal | "TEAM_NOT_FOUND" | "ORGANIZATION_UNAVAILABLE"; message: string }
  | DailyLimitReached
  | { kind: "done"; rows: BulkRow[] };

export type TokenOutcome<T> = { kind: "refused"; code: TokenRefusal } | T;

export type AcceptOutcome = TokenOutcome<
  | { kind: "validation"; code: "INVALID_INPUT" | "WEAK_PASSWORD"; message: string }
  | { kind: "email_mismatch" }
  | { kind: "invalid_identity" }
  | { kind: "account_not_found" }
  | { kind: "account_exists" }
  | { kind: "wrong_password" }
  | { kind: "blocked" }
  | { kind: "conflict"; code: "ALREADY_MEMBER" | "EMAIL_IN_ANOTHER_ORGANIZATION" | "LEGACY_ACCOUNT_PENDING_PLACEMENT" | "MEMBER_DEACTIVATED"; message: string }
  | { kind: "sso_required" }
  | { kind: "accepted"; userId: string; organizationId: string; role: InvitableRole; method: AcceptMethod }
>;

export type AcceptMethod = "password" | "sso" | "company_sso";

/** An identity a provider has already verified (Google, Microsoft or the company's own IdP). */
export type VerifiedInvitee = {
  email: string;
  name?: string;
  avatar?: string;
  googleId?: string;
  federatedIdentity?: { provider: "microsoft" | "company_oidc"; issuer: string; subject: string };
};

export type InvitationServiceDependencies = {
  invitations: InvitationRepository;
  invitees: InviteeDirectory;
  organizations: OrganizationDirectory;
  teams: InvitationTeamDirectory;
  acceptance: InvitationAcceptanceStore;
  credentials: InviteeCredentials;
  passwords: { hash(password: string): Promise<string>; verify(password: string, hash: string): Promise<boolean> };
  dispatcher: Pick<InvitationDispatcher, "dispatch" | "dispatchInBackground">;
  audit: InvitationAuditWriter;
  quota: InvitationEmailQuota;
  google: GoogleIdentityVerifier;
  // A random secret for a Google-created account's unusable password, as Google sign-up does.
  randomSecret(): string;
  /** Require SSO: this email must use its organization's company sign-in, not Google/Microsoft. */
  ssoRequiredFor?(email: string): Promise<boolean>;
  // True when this organization has an active company SSO connection for the email's domain.
  companySsoFor?(organizationId: string, email: string): Promise<boolean>;
  dailyEmailLimit?: number;
  resendCooldownMs?: number;
  now?: () => Date;
};

const secondsUntilNextUtcDay = (at: Date): number => {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
};

export const createInvitationService = (deps: InvitationServiceDependencies) => {
  const now = deps.now ?? (() => new Date());
  const dailyEmailLimit = deps.dailyEmailLimit ?? DEFAULT_DAILY_INVITATION_EMAIL_LIMIT;
  const resendCooldownMs = deps.resendCooldownMs ?? RESEND_COOLDOWN_MS;

  const reserveEmails = async (organizationId: string, count: number, at: Date): Promise<DailyLimitReached | null> => {
    const reserved = await deps.quota.reserve({ organizationId, count, limit: dailyEmailLimit, now: at });
    if (reserved.ok) return null;
    return {
      kind: "limited",
      code: "INVITATION_DAILY_LIMIT",
      message: reserved.remaining > 0
        ? `Your organization can send ${reserved.remaining} more invitation emails today. Invite fewer people or try again tomorrow.`
        : "Your organization has sent today's maximum number of invitation emails. Try again tomorrow.",
      remaining: reserved.remaining,
      retryAfterSeconds: secondsUntilNextUtcDay(at),
    };
  };

  const auditSent = (actor: InvitingActor, invitation: InvitationRecord, correlationId: string, action = "organization.invitation.sent") =>
    deps.audit.append({
      organizationId: invitation.organizationId,
      actorUserId: actor.userId,
      action,
      targetType: "invitation",
      targetId: invitation.id,
      decision: "created",
      reason: action === "organization.invitation.sent" ? "invited" : "resent",
      correlationId,
      metadata: { role: invitation.role, teamId: invitation.teamId },
    });

  const createMany = async (
    actor: InvitingActor,
    rawEmails: string[],
    input: CreateInput,
    options: { correlationId: string; deliverInline: boolean },
  ): Promise<CreateOutcome> => {
    if (!isInvitableRole(input.role)) {
      return { kind: "validation", code: "INVALID_ROLE", message: "Choose a role: organization_admin, team_manager, planner or viewer." };
    }
    const role = input.role;
    const teamId = input.teamId === undefined || input.teamId === null || input.teamId === "" ? null : input.teamId;
    if (teamId !== null && (typeof teamId !== "string" || !objectIdPattern.test(teamId))) {
      return { kind: "validation", code: "INVALID_TEAM", message: "The team id isn't valid." };
    }
    if (rawEmails.length === 0) return { kind: "validation", code: "NO_EMAILS", message: "Enter at least one email address." };
    if (rawEmails.length > MAX_BULK_INVITATIONS) {
      return { kind: "validation", code: "TOO_MANY_EMAILS", message: `Invite at most ${MAX_BULK_INVITATIONS} people at a time.` };
    }

    const organization = await deps.organizations.find(actor.organizationId);
    if (!organization?.invitable) {
      return { kind: "forbidden", code: "ORGANIZATION_UNAVAILABLE", message: "This organization can't send invitations." };
    }
    // The permission doesn't depend on the email, so a refused actor gets one answer, not 200 rows.
    const refusal = inviteRefusal(actor, { role, teamId }, organization);
    if (refusal) return { kind: "forbidden", code: refusal, message: ROW_REFUSAL_MESSAGES[refusal] };
    if (teamId && !(await deps.teams.findTeams(actor.organizationId, [teamId])).has(teamId)) {
      return { kind: "forbidden", code: "TEAM_NOT_FOUND", message: ROW_REFUSAL_MESSAGES.TEAM_NOT_FOUND };
    }

    const at = now();
    const emails = rawEmails.map(normalizeEmail);
    const valid = [...new Set(emails.filter(isValidEmail))];
    await deps.invitations.expireLapsed(actor.organizationId, valid, at);
    const [standings, pending] = await Promise.all([
      deps.invitees.standings(actor.organizationId, valid),
      deps.invitations.pendingEmails(actor.organizationId, valid, at),
    ]);

    const seen = new Set<string>();
    const rows: BulkRow[] = [];
    const candidates: { index: number; email: string }[] = [];
    for (const [index, email] of emails.entries()) {
      const refuse = (code: RowRefusal) => { rows[index] = { row: index + 1, email: rawEmails[index].trim(), outcome: "refused", code, message: ROW_REFUSAL_MESSAGES[code] }; };
      if (!isValidEmail(email)) { refuse("INVALID_EMAIL"); continue; }
      if (seen.has(email)) { refuse("DUPLICATE_IN_LIST"); continue; }
      seen.add(email);
      const blocked = standingRefusal(standings.get(email));
      if (blocked) { refuse(blocked); continue; }
      if (pending.has(email)) { refuse("ALREADY_INVITED"); continue; }
      candidates.push({ index, email });
    }

    // Every row that would get an email counts against the day's allowance, before any is written.
    if (candidates.length) {
      const limited = await reserveEmails(actor.organizationId, candidates.length, at);
      if (limited) return limited;
    }

    const created: InvitationRecord[] = [];
    for (const { index, email } of candidates) {
      const inserted = await deps.invitations.insertPending({
        organizationId: actor.organizationId,
        email,
        role,
        teamId,
        invitedBy: actor.userId,
        expiresAt: new Date(at.getTime() + INVITATION_TTL_MS),
      });
      if (inserted.kind === "duplicate") {
        rows[index] = { row: index + 1, email, outcome: "refused", code: "ALREADY_INVITED", message: ROW_REFUSAL_MESSAGES.ALREADY_INVITED };
        continue;
      }
      created.push(inserted.invitation);
      await auditSent(actor, inserted.invitation, options.correlationId);
      rows[index] = { row: index + 1, email, outcome: "invited", invitation: toInvitationView(inserted.invitation, at) };
    }

    if (options.deliverInline) {
      for (const invitation of created) {
        const delivered = await deps.dispatcher.dispatch(invitation.id);
        const row = rows.find((entry) => entry.outcome === "invited" && entry.invitation.id === invitation.id);
        if (row?.outcome === "invited") row.invitation.emailDelivery = delivered;
      }
    } else if (created.length) {
      deps.dispatcher.dispatchInBackground(created.map((invitation) => invitation.id));
    }
    return { kind: "done", rows };
  };

  const loadManageable = async (actor: InvitingActor, id: string) => {
    if (!objectIdPattern.test(id)) return null;
    const [invitation, organization] = await Promise.all([
      deps.invitations.findById(actor.organizationId, id),
      deps.organizations.find(actor.organizationId),
    ]);
    if (!invitation || !organization) return null;
    return mayManageInvitation(actor, invitation, organization) ? invitation : null;
  };

  const resolveToken = async (
    token: unknown,
  ): Promise<{ refusal: TokenRefusal } | { invitation: InvitationRecord; tokenHash: string }> => {
    if (!looksLikeInvitationToken(token)) return { refusal: "INVITATION_INVALID" };
    const tokenHash = hashInvitationToken(token);
    const found = await deps.invitations.findByTokenHash(tokenHash);
    const refusal = tokenRefusal(found ? { status: found.invitation.status, expiresAt: found.invitation.expiresAt, current: found.current } : null, now());
    if (refusal || !found) return { refusal: refusal ?? "INVITATION_INVALID" };
    return { invitation: found.invitation, tokenHash };
  };

  const auditAccepted = (
    invitation: InvitationRecord,
    result: Awaited<ReturnType<InvitationAcceptanceStore["joinExistingAccount"]>>,
    correlationId: string,
    reason: "new_account" | "existing_account" | `${"google" | "microsoft" | "company_oidc" | "sso"}_${"new" | "existing"}_account`,
  ) => {
    if (result.kind !== "joined") return Promise.resolve();
    return deps.audit.append({
      organizationId: invitation.organizationId,
      actorUserId: result.userId,
      action: "organization.invitation.accepted",
      targetType: "invitation",
      targetId: invitation.id,
      decision: "allowed",
      reason,
      correlationId,
      metadata: {
        role: invitation.role,
        teamId: invitation.teamId,
        invitedBy: invitation.invitedBy,
        ...(invitation.teamId ? { placedInTeam: result.placedInTeam } : {}),
      },
    });
  };

  const conflictFor = (standing: InviteeStanding | undefined): AcceptOutcome | null => {
    const refusal = standingRefusal(standing);
    if (refusal === "ALREADY_MEMBER" || refusal === "MEMBER_DEACTIVATED" || refusal === "EMAIL_IN_ANOTHER_ORGANIZATION" || refusal === "LEGACY_ACCOUNT_PENDING_PLACEMENT") {
      return { kind: "conflict", code: refusal, message: ROW_REFUSAL_MESSAGES[refusal] };
    }
    return null;
  };

  const joinOutcome = (
    result: Awaited<ReturnType<InvitationAcceptanceStore["joinExistingAccount"]>>,
    invitation: InvitationRecord,
    method: AcceptMethod = "password",
  ): AcceptOutcome => {
    if (result.kind === "joined") {
      return { kind: "accepted", userId: result.userId, organizationId: invitation.organizationId, role: invitation.role, method };
    }
    // The invitation changed between the check and the write: revoked, resent, expired or used.
    if (result.kind === "stale") return { kind: "refused", code: "INVITATION_ALREADY_USED" };
    if (result.kind === "account_exists") return { kind: "account_exists" };
    return { kind: "conflict", code: result.code, message: ROW_REFUSAL_MESSAGES[result.code] };
  };

  return {
    async create(actor: InvitingActor, input: CreateInput & { email?: unknown }, correlationId: string) {
      const email = typeof input.email === "string" ? input.email : "";
      return createMany(actor, email.trim() ? [email] : [], input, { correlationId, deliverInline: true });
    },

    async createBulk(actor: InvitingActor, input: CreateInput & { emails?: unknown }, correlationId: string) {
      return createMany(actor, parseEmailList(input.emails), input, { correlationId, deliverInline: false });
    },

    async list(actor: InvitingActor, filter: { status?: unknown }) {
      const status = typeof filter.status === "string" && ["pending", "accepted", "revoked", "expired"].includes(filter.status)
        ? (filter.status as InvitationStatus)
        : undefined;
      const organization = await deps.organizations.find(actor.organizationId);
      if (!organization) return [];
      const at = now();
      const rows = await deps.invitations.list(actor.organizationId, { status });
      return rows
        .filter((invitation) => mayManageInvitation(actor, invitation, organization))
        .map((invitation) => toInvitationView(invitation, at))
        // A pending row past its expiry is listed as expired, so filter on the effective status.
        .filter((view) => !status || view.status === status);
    },

    async resend(actor: InvitingActor, id: string, correlationId: string) {
      const invitation = await loadManageable(actor, id);
      if (!invitation) return { kind: "not_found" as const };
      const at = now();
      // An expired invitation can be resent too: it gets a new link and a new week.
      if (!["pending", "expired"].includes(effectiveStatus(invitation, at))) {
        return { kind: "not_pending" as const, status: invitation.status };
      }
      const cooldown = (record: InvitationRecord) => {
        const waitMs = record.emailQueuedAt.getTime() + resendCooldownMs - at.getTime();
        return waitMs > 0 ? { kind: "cooldown" as const, retryAfterSeconds: Math.ceil(waitMs / 1000) } : null;
      };
      const tooSoon = cooldown(invitation);
      if (tooSoon) return tooSoon;
      const standings = await deps.invitees.standings(actor.organizationId, [invitation.email]);
      const blocked = standingRefusal(standings.get(invitation.email));
      if (blocked) return { kind: "refused" as const, code: blocked, message: ROW_REFUSAL_MESSAGES[blocked] };
      const limited = await reserveEmails(actor.organizationId, 1, at);
      if (limited) return limited;
      const prepared = await deps.invitations.prepareResend(actor.organizationId, id, {
        now: at,
        expiresAt: new Date(at.getTime() + INVITATION_TTL_MS),
        queuedBefore: new Date(at.getTime() - resendCooldownMs),
      });
      if (!prepared) {
        // A concurrent resend got there first, or the invitation was accepted or revoked meanwhile.
        const current = await deps.invitations.findById(actor.organizationId, id);
        const raced = current && ["pending", "expired"].includes(current.status) ? cooldown(current) : null;
        return raced ?? { kind: "not_pending" as const, status: current?.status ?? invitation.status };
      }
      await auditSent(actor, prepared, correlationId, "organization.invitation.resent");
      const delivered = await deps.dispatcher.dispatch(prepared.id);
      return { kind: "resent" as const, invitation: { ...toInvitationView(prepared, at), emailDelivery: delivered } };
    },

    async revoke(actor: InvitingActor, id: string, correlationId: string) {
      const invitation = await loadManageable(actor, id);
      if (!invitation) return { kind: "not_found" as const };
      const at = now();
      const revoked = await deps.invitations.revoke(actor.organizationId, id, { by: actor.userId, now: at });
      if (!revoked) return { kind: "not_pending" as const, status: invitation.status };
      await deps.audit.append({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "organization.invitation.revoked",
        targetType: "invitation",
        targetId: id,
        decision: "revoked",
        reason: "revoked_by_admin",
        correlationId,
        metadata: { role: revoked.role, teamId: revoked.teamId },
      });
      return { kind: "revoked" as const, invitation: toInvitationView(revoked, at) };
    },

    // What the accept page shows before anyone signs in. Only the holder of a live link gets this.
    async lookup(token: unknown) {
      const resolved = await resolveToken(token);
      if ("refusal" in resolved) return { kind: "refused" as const, code: resolved.refusal };
      const { invitation } = resolved;
      const [organization, inviterName, teams, credentials, companySso] = await Promise.all([
        deps.organizations.find(invitation.organizationId),
        deps.organizations.userName(invitation.invitedBy),
        invitation.teamId ? deps.teams.findTeams(invitation.organizationId, [invitation.teamId]) : Promise.resolve(new Map()),
        deps.credentials.emailExists(invitation.email),
        deps.companySsoFor ? deps.companySsoFor(invitation.organizationId, invitation.email) : Promise.resolve(false),
      ]);
      if (!organization) return { kind: "refused" as const, code: "INVITATION_INVALID" as const };
      return {
        kind: "found" as const,
        invitation: {
          email: invitation.email,
          role: invitation.role,
          organizationName: organization.name,
          inviterName,
          teamName: invitation.teamId ? teams.get(invitation.teamId)?.name ?? null : null,
          expiresAt: invitation.expiresAt.toISOString(),
          // Tells the page whether to offer sign-in or sign-up.
          accountExists: credentials,
          // Tells the page whether to offer "Sign in with your company".
          companySso,
        },
      };
    },

    // An existing account signs in with the invited email; role and organization come from the invite.
    async acceptWithExistingAccount(input: { token?: unknown; email?: unknown; password?: unknown }, correlationId: string): Promise<AcceptOutcome> {
      const resolved = await resolveToken(input.token);
      if ("refusal" in resolved) return { kind: "refused", code: resolved.refusal };
      const { invitation, tokenHash } = resolved;
      const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!email || !password) return { kind: "validation", code: "INVALID_INPUT", message: "Email and password are required." };
      if (email !== invitation.email) return { kind: "email_mismatch" };
      const account = await deps.credentials.findCredentials(email);
      if (!account) return { kind: "account_not_found" };
      if (!(await deps.passwords.verify(password, account.passwordHash))) return { kind: "wrong_password" };
      if (account.isBlocked) return { kind: "blocked" };
      const conflict = conflictFor((await deps.invitees.standings(invitation.organizationId, [email])).get(email));
      if (conflict) return conflict;
      const result = await deps.acceptance.joinExistingAccount({ invitationId: invitation.id, tokenHash, userId: account.user.id, now: now() });
      await auditAccepted(invitation, result, correlationId, "existing_account");
      return joinOutcome(result, invitation);
    },

    // Google proves the email the way a password does, so an account with no usable password
    // (created by Google sign-in) can accept, and a new invitee can sign up with Google without
    // getting an organization of their own. The verified Google email must equal the invited one.
    async acceptWithGoogle(input: { token?: unknown; idToken?: unknown }, correlationId: string): Promise<AcceptOutcome> {
      const resolved = await resolveToken(input.token);
      if ("refusal" in resolved) return { kind: "refused", code: resolved.refusal };
      if (typeof input.idToken !== "string" || !input.idToken.trim()) {
        return { kind: "validation", code: "INVALID_INPUT", message: "A Google ID token is required." };
      }
      let identity: VerifiedGoogleIdentity;
      try {
        identity = await deps.google.verify(input.idToken.trim());
      } catch {
        return { kind: "invalid_identity" };
      }
      return this.acceptWithVerifiedIdentity(
        input.token,
        { email: identity.email, name: identity.name, avatar: identity.avatar, googleId: identity.subject },
        "sso",
        correlationId,
      );
    },

    // Shared by Google, Microsoft and company SSO: the provider has already proven the email.
    // Company SSO (`company_sso`) is the organization's own IdP, so Require SSO never blocks it.
    async acceptWithVerifiedIdentity(token: unknown, invitee: VerifiedInvitee, method: "sso" | "company_sso", correlationId: string): Promise<AcceptOutcome> {
      const resolved = await resolveToken(token);
      if ("refusal" in resolved) return { kind: "refused", code: resolved.refusal };
      const { invitation, tokenHash } = resolved;
      const email = normalizeEmail(invitee.email);
      if (email !== invitation.email) return { kind: "email_mismatch" };
      if (method === "sso" && (await deps.ssoRequiredFor?.(email))) return { kind: "sso_required" };
      const via: "google" | "microsoft" | "company_oidc" | "sso" = invitee.googleId ? "google" : invitee.federatedIdentity?.provider ?? "sso";
      const account = await deps.credentials.findCredentials(email);
      if (account) {
        if (account.isBlocked) return { kind: "blocked" };
        const conflict = conflictFor((await deps.invitees.standings(invitation.organizationId, [email])).get(email));
        if (conflict) return conflict;
        const result = await deps.acceptance.joinExistingAccount({ invitationId: invitation.id, tokenHash, userId: account.user.id, now: now() });
        await auditAccepted(invitation, result, correlationId, `${via}_existing_account`);
        return joinOutcome(result, invitation, method);
      }
      const result = await deps.acceptance.joinNewAccount({
        invitationId: invitation.id,
        tokenHash,
        name: (invitee.name?.trim() || email.split("@")[0]).slice(0, 200),
        passwordHash: await deps.passwords.hash(deps.randomSecret()),
        googleId: invitee.googleId,
        federatedIdentity: invitee.federatedIdentity,
        avatar: invitee.avatar,
        now: now(),
      });
      await auditAccepted(invitation, result, correlationId, `${via}_new_account`);
      return joinOutcome(result, invitation, method);
    },

    /** The organization an invitation token belongs to, or null when the link isn't live. */
    async organizationOfToken(token: unknown): Promise<string | null> {
      const resolved = await resolveToken(token);
      return "refusal" in resolved ? null : resolved.invitation.organizationId;
    },

    // A new account is created with the invited email: the link reached that inbox, which is the
    // same proof the signup OTP gives. No organization of their own is created.
    async acceptWithNewAccount(input: { token?: unknown; name?: unknown; password?: unknown; phone?: unknown }, correlationId: string): Promise<AcceptOutcome> {
      const resolved = await resolveToken(input.token);
      if ("refusal" in resolved) return { kind: "refused", code: resolved.refusal };
      const { invitation, tokenHash } = resolved;
      const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!name || !password) return { kind: "validation", code: "INVALID_INPUT", message: "Name and password are required." };
      if (password.length < 8) return { kind: "validation", code: "WEAK_PASSWORD", message: "Password must be at least 8 characters." };
      if (await deps.credentials.emailExists(invitation.email)) return { kind: "account_exists" };
      const result = await deps.acceptance.joinNewAccount({
        invitationId: invitation.id,
        tokenHash,
        name,
        phone: typeof input.phone === "string" && input.phone.trim() ? input.phone.trim().slice(0, 40) : undefined,
        passwordHash: await deps.passwords.hash(password),
        now: now(),
      });
      await auditAccepted(invitation, result, correlationId, "new_account");
      return joinOutcome(result, invitation);
    },
  };
};

export type InvitationService = ReturnType<typeof createInvitationService>;
