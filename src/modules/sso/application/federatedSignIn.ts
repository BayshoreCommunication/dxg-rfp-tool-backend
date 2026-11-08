import crypto from "node:crypto";
import {
  emailDomain,
  isEmail,
  microsoftIssuerFor,
  MICROSOFT_AUTHORITY,
  normalizeEmail,
  personFromCompanyClaims,
  personFromMicrosoftClaims,
  type FederatedKind,
  type IdTokenClaims,
  type VerifiedPerson,
} from "../domain/ssoRules";
import type { ProviderMetadata, SsoStateStore } from "../domain/ports";

/* Microsoft and company-OIDC sign-in (see tasks/2026-11-04-sso/IMPLEMENTATION_PLAN.md).

   start     → remembers {nonce, PKCE verifier, ...} under a random state; returns the IdP URL
   callback  → takes the state once, exchanges the code, verifies the ID token, resolves the
               account (link, join as Planner, new Owner, or accept an invitation) and parks
               the outcome under a 60-second single-use handoff id
   exchange  → the dashboard (BFF) redeems the handoff with the browser's binding secret;
               the controller then issues the session like /api/auth/google

   The binding secret lives in an httpOnly cookie the dashboard set before redirecting; only
   its hash travels through the IdP. A handoff id leaked from a URL is useless without it,
   and an attacker can't plant their own sign-in in a victim's browser (login CSRF). */

export const STATE_TTL_MS = 10 * 60_000;
export const HANDOFF_TTL_MS = 60_000;
const MICROSOFT_DISCOVERY = `${MICROSOFT_AUTHORITY}/common/v2.0`;
const MICROSOFT_TEMPLATE_ISSUER = `${MICROSOFT_AUTHORITY}/{tenantid}/v2.0`;

export type SsoErrorCode =
  | "SSO_INVALID_REQUEST"
  | "SSO_NOT_CONFIGURED"
  | "MICROSOFT_NOT_CONFIGURED"
  | "SSO_PROVIDER_UNAVAILABLE"
  | "SSO_STATE_INVALID"
  | "SSO_CANCELLED"
  | "SSO_IDENTITY_INVALID"
  | "EMAIL_MISSING"
  | "MICROSOFT_EMAIL_UNVERIFIED"
  | "COMPANY_EMAIL_UNVERIFIED"
  | "SSO_DOMAIN_NOT_ALLOWED"
  | "SSO_IDENTITY_MISMATCH"
  | "SSO_REQUIRED"
  | "EMAIL_IN_ANOTHER_ORGANIZATION"
  | "MEMBER_DEACTIVATED"
  | "USER_BLOCKED"
  | "SSO_INVITE_ORG_MISMATCH"
  | "SSO_HANDOFF_INVALID"
  | "ORGANIZATION_DOMAIN_MATCH"
  | string; // invitation refusal codes pass through unchanged

export type ActiveConnection = {
  id: string;
  organizationId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  domains: string[];
};

export type FederatedAccount = {
  userId: string;
  organizationId: string | null;
  isBlocked: boolean;
  identities: { issuer: string; subject: string }[];
};

export type SignedInOutcome = {
  userId: string;
  organizationId: string;
  method: "sso" | "company_sso";
  isNewUser: boolean;
  role?: string;
  organizationName?: string;
};

export type InvitationOutcome =
  | { kind: "accepted"; userId: string; organizationId: string; role: string; organizationName?: string }
  | { kind: "refused"; code: string };

export type FederatedSignInDependencies = {
  store: SsoStateStore;
  oidc: {
    discover(discoveryIssuer: string, expectedIssuer?: string): Promise<ProviderMetadata>;
    authorizationUrl(metadata: ProviderMetadata, input: {
      clientId: string; redirectUri: string; state: string; nonce: string; codeVerifier: string; loginHint?: string; extra?: Record<string, string>;
    }): string;
    exchangeCode(metadata: ProviderMetadata, input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }): Promise<string>;
    verifyIdToken(metadata: ProviderMetadata, idToken: string, input: {
      clientId: string; nonce: string; issuer?: string; issuerFor?: (claims: Record<string, unknown>) => string | null;
    }): Promise<IdTokenClaims>;
  };
  microsoft: () => { clientId: string; clientSecret: string } | null;
  redirectUri: () => string;
  connections: {
    activeForDomain(domain: string): Promise<ActiveConnection | null>;
    activeById(id: string): Promise<ActiveConnection | null>;
    organizationVerifiedDomains(organizationId: string): Promise<string[]>;
  };
  accounts: {
    findByIdentity(issuer: string, subject: string): Promise<FederatedAccount | null>;
    findByEmail(email: string): Promise<FederatedAccount | null>;
    link(userId: string, person: VerifiedPerson): Promise<void>;
    createOwner(person: VerifiedPerson): Promise<{ userId: string; organizationId: string }>;
    joinOrganization(organizationId: string, person: VerifiedPerson, role: "planner"): Promise<{ userId: string }>;
    membership(organizationId: string, userId: string): Promise<{ status: string; roles: string[] } | null>;
    addMembership(organizationId: string, userId: string, role: "planner"): Promise<void>;
  };
  /** Require SSO: true when this email must use its company connection instead. */
  ssoRequiredFor(email: string): Promise<boolean>;
  invitations: {
    organizationOf(token: string): Promise<string | null>;
    acceptWithPerson(token: string, person: VerifiedPerson, method: "sso" | "company_sso", correlationId: string): Promise<InvitationOutcome>;
  };
  audit(event: { organizationId: string; userId: string; action: string; reason: string; correlationId: string; metadata?: Record<string, unknown> }): Promise<void>;
  /** ORG-306: the organization that verified the email's domain, if any. */
  domainOrganizationFor?(email: string): Promise<{ name: string } | null>;
};

type PendingAuthorization = {
  kind: FederatedKind;
  connectionId: string | null;
  nonce: string;
  codeVerifier: string;
  bindHash: string;
  inviteToken: string | null;
};

type Handoff = { bindHash: string; outcome: SignedInOutcome };

export type CallbackResult =
  | { kind: "handoff"; handoff: string }
  | { kind: "error"; code: SsoErrorCode; inviteToken: string | null };

// The dashboard sends the lowercase hex SHA-256 of its bind cookie at start, and the cookie itself at exchange.
const hashBind = (bind: string) => crypto.createHash("sha256").update(bind, "utf8").digest("hex");
const isBindHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isInviteToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(value);
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export const createFederatedSignIn = (deps: FederatedSignInDependencies) => {
  const microsoftMetadata = () => deps.oidc.discover(MICROSOFT_DISCOVERY, MICROSOFT_TEMPLATE_ISSUER);

  const start = async (input: { kind?: unknown; email?: unknown; invite?: unknown; bind?: unknown }) => {
    if (!isBindHash(input.bind)) return { kind: "error" as const, code: "SSO_INVALID_REQUEST" as const };
    const inviteToken = input.invite === undefined || input.invite === "" ? null : input.invite;
    if (inviteToken !== null && !isInviteToken(inviteToken)) return { kind: "error" as const, code: "SSO_INVALID_REQUEST" as const };
    const state = random();
    const nonce = random();
    const codeVerifier = random(48);
    const pending = (kind: FederatedKind, connectionId: string | null): PendingAuthorization =>
      ({ kind, connectionId, nonce, codeVerifier, bindHash: input.bind as string, inviteToken });

    try {
      if (input.kind === "microsoft") {
        const config = deps.microsoft();
        if (!config) return { kind: "error" as const, code: "MICROSOFT_NOT_CONFIGURED" as const };
        const metadata = await microsoftMetadata();
        await deps.store.put("state", state, pending("microsoft", null), STATE_TTL_MS);
        return {
          kind: "redirect" as const,
          url: deps.oidc.authorizationUrl(metadata, {
            clientId: config.clientId, redirectUri: deps.redirectUri(), state, nonce, codeVerifier,
            extra: { prompt: "select_account" },
          }),
        };
      }
      if (input.kind === "company") {
        const email = normalizeEmail(input.email);
        if (!isEmail(email)) return { kind: "error" as const, code: "SSO_INVALID_REQUEST" as const };
        const connection = await deps.connections.activeForDomain(emailDomain(email));
        // Same answer for "no such company" and "company without SSO": nothing about who uses RFPilot leaks.
        if (!connection) return { kind: "error" as const, code: "SSO_NOT_CONFIGURED" as const };
        const metadata = await deps.oidc.discover(connection.issuer);
        await deps.store.put("state", state, pending("company", connection.id), STATE_TTL_MS);
        return {
          kind: "redirect" as const,
          url: deps.oidc.authorizationUrl(metadata, {
            clientId: connection.clientId, redirectUri: deps.redirectUri(), state, nonce, codeVerifier, loginHint: email,
          }),
        };
      }
    } catch {
      return { kind: "error" as const, code: "SSO_PROVIDER_UNAVAILABLE" as const };
    }
    return { kind: "error" as const, code: "SSO_INVALID_REQUEST" as const };
  };

  // Existing member of `organizationId` (or a legacy account placed there without a membership row).
  const ensureCompanyMember = async (organizationId: string, userId: string): Promise<SsoErrorCode | null> => {
    const membership = await deps.accounts.membership(organizationId, userId);
    if (!membership) {
      await deps.accounts.addMembership(organizationId, userId, "planner");
      return null;
    }
    return membership.status === "active" ? null : "MEMBER_DEACTIVATED";
  };

  const resolveAccount = async (
    pending: PendingAuthorization, person: VerifiedPerson, connection: ActiveConnection | null, correlationId: string,
  ): Promise<SignedInOutcome | { error: SsoErrorCode }> => {
    const method = pending.kind === "company" ? "company_sso" as const : "sso" as const;

    if (pending.inviteToken) {
      if (connection && (await deps.invitations.organizationOf(pending.inviteToken)) !== connection.organizationId) {
        return { error: "SSO_INVITE_ORG_MISMATCH" };
      }
      const accepted = await deps.invitations.acceptWithPerson(pending.inviteToken, person, method, correlationId);
      if (accepted.kind === "refused") return { error: accepted.code };
      return {
        userId: accepted.userId, organizationId: accepted.organizationId, method, isNewUser: false,
        role: accepted.role, organizationName: accepted.organizationName,
      };
    }

    let account = await deps.accounts.findByIdentity(person.issuer, person.subject);
    if (!account) {
      account = await deps.accounts.findByEmail(person.email);
      if (account) {
        // The same IdP already vouched for a different person with this email: don't relink.
        if (account.identities.some((identity) => identity.issuer === person.issuer && identity.subject !== person.subject)) {
          return { error: "SSO_IDENTITY_MISMATCH" };
        }
        if (connection && account.organizationId !== connection.organizationId) return { error: "EMAIL_IN_ANOTHER_ORGANIZATION" };
        if (account.isBlocked) return { error: "USER_BLOCKED" };
        await deps.accounts.link(account.userId, person);
      }
    }

    if (account) {
      if (account.isBlocked) return { error: "USER_BLOCKED" };
      if (connection) {
        if (account.organizationId !== connection.organizationId) return { error: "EMAIL_IN_ANOTHER_ORGANIZATION" };
        const refusal = await ensureCompanyMember(connection.organizationId, account.userId);
        if (refusal) return { error: refusal };
      }
      if (!account.organizationId) return { error: "SSO_IDENTITY_INVALID" };
      return { userId: account.userId, organizationId: account.organizationId, method, isNewUser: false };
    }

    if (connection) {
      const joined = await deps.accounts.joinOrganization(connection.organizationId, person, "planner");
      await deps.audit({
        organizationId: connection.organizationId, userId: joined.userId, action: "organization.member.sso_joined",
        reason: "company_sso_first_sign_in", correlationId, metadata: { role: "planner", connectionId: connection.id },
      });
      return { userId: joined.userId, organizationId: connection.organizationId, method, isNewUser: true, role: "planner" };
    }
    // ORG-306: a new Microsoft account on another organization's verified domain doesn't get an
    // organization of its own here; email sign-up lets the person request access or choose to
    // create a separate organization.
    if (await deps.domainOrganizationFor?.(person.email)) return { error: "ORGANIZATION_DOMAIN_MATCH" };
    const created = await deps.accounts.createOwner(person);
    return { ...created, method, isNewUser: true };
  };

  const callback = async (input: { code?: unknown; state?: unknown; error?: unknown }, correlationId: string): Promise<CallbackResult> => {
    if (typeof input.state !== "string" || !input.state || input.state.length > 200) {
      return { kind: "error", code: "SSO_STATE_INVALID", inviteToken: null };
    }
    const pending = await deps.store.take<PendingAuthorization>("state", input.state);
    if (!pending) return { kind: "error", code: "SSO_STATE_INVALID", inviteToken: null };
    const fail = (code: SsoErrorCode): CallbackResult => ({ kind: "error", code, inviteToken: pending.inviteToken });
    if (input.error !== undefined) return fail("SSO_CANCELLED");
    if (typeof input.code !== "string" || !input.code || input.code.length > 4096) return fail("SSO_INVALID_REQUEST");

    let connection: ActiveConnection | null = null;
    let person: VerifiedPerson;
    try {
      if (pending.kind === "microsoft") {
        const config = deps.microsoft();
        if (!config) return fail("MICROSOFT_NOT_CONFIGURED");
        const metadata = await microsoftMetadata();
        const idToken = await deps.oidc.exchangeCode(metadata, {
          ...config, redirectUri: deps.redirectUri(), code: input.code, codeVerifier: pending.codeVerifier,
        });
        const claims = await deps.oidc.verifyIdToken(metadata, idToken, {
          clientId: config.clientId, nonce: pending.nonce, issuerFor: (c) => microsoftIssuerFor(c.tid),
        });
        const result = personFromMicrosoftClaims(claims);
        if ("refusal" in result) return fail(result.refusal);
        person = result;
      } else {
        connection = pending.connectionId ? await deps.connections.activeById(pending.connectionId) : null;
        if (!connection) return fail("SSO_NOT_CONFIGURED");
        const metadata = await deps.oidc.discover(connection.issuer);
        const idToken = await deps.oidc.exchangeCode(metadata, {
          clientId: connection.clientId, clientSecret: connection.clientSecret, redirectUri: deps.redirectUri(),
          code: input.code, codeVerifier: pending.codeVerifier,
        });
        const claims = await deps.oidc.verifyIdToken(metadata, idToken, {
          clientId: connection.clientId, nonce: pending.nonce, issuer: metadata.issuer,
        });
        const result = personFromCompanyClaims(claims);
        if ("refusal" in result) return fail(result.refusal);
        person = result;
        // The domain must be the connection's and still verified by its organization right now.
        const domain = emailDomain(person.email);
        const verified = await deps.connections.organizationVerifiedDomains(connection.organizationId);
        if (!connection.domains.includes(domain) || !verified.includes(domain)) return fail("SSO_DOMAIN_NOT_ALLOWED");
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      return fail(code === "ID_TOKEN_INVALID" ? "SSO_IDENTITY_INVALID" : "SSO_PROVIDER_UNAVAILABLE");
    }

    if (pending.kind === "microsoft" && (await deps.ssoRequiredFor(person.email))) return fail("SSO_REQUIRED");

    const outcome = await resolveAccount(pending, person, connection, correlationId);
    if ("error" in outcome) return fail(outcome.error);
    const handoff = random();
    await deps.store.put("handoff", handoff, { bindHash: pending.bindHash, outcome } satisfies Handoff, HANDOFF_TTL_MS);
    return { kind: "handoff", handoff };
  };

  const exchange = async (input: { handoff?: unknown; bind?: unknown }) => {
    if (typeof input.handoff !== "string" || !input.handoff || input.handoff.length > 200 || typeof input.bind !== "string" || !input.bind) {
      return { kind: "error" as const, code: "SSO_HANDOFF_INVALID" as const };
    }
    const parked = await deps.store.take<Handoff>("handoff", input.handoff);
    if (!parked) return { kind: "error" as const, code: "SSO_HANDOFF_INVALID" as const };
    const presented = Buffer.from(hashBind(input.bind));
    const expected = Buffer.from(parked.bindHash);
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      return { kind: "error" as const, code: "SSO_HANDOFF_INVALID" as const };
    }
    return { kind: "signed_in" as const, outcome: parked.outcome };
  };

  return { start, callback, exchange };
};

export const bindHashFor = hashBind;
export type FederatedSignIn = ReturnType<typeof createFederatedSignIn>;
