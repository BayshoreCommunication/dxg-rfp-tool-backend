import crypto from "node:crypto";
import { createRemoteJWKSet } from "jose";
import { bcryptPasswordHasher } from "../../shared/security/bcryptPasswordHasher";
import { createSecretBox, parseEncryptionKey, type SecretBox } from "../../shared/security/secretBox";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { authenticationSessions } from "../auth/composition";
import { invitations } from "../invitations/composition";
import { createFederatedSignIn } from "./application/federatedSignIn";
import { createManageSsoConnection } from "./application/manageSsoConnection";
import { authorizationUrl, discover, exchangeCode, verifyIdToken } from "./infrastructure/oidcClient";
import { ssoStateStore } from "./infrastructure/ssoStateStore";
import {
  createMongoConnectionLookup,
  createMongoFederatedAccounts,
  mongoSsoConnectionRepository,
  mongoSsoOrganizations,
  mongoSsoRequiredFor,
} from "./infrastructure/mongoSsoRepositories";

export class SsoNotConfiguredError extends Error {}

/* SSO_SECRET_KEY (32 bytes, hex or base64) seals company client secrets. Production refuses
   to store one without it; elsewhere a key derived from JWT_SECRET keeps local runs simple. */
let cachedBox: { source: string; box: SecretBox } | undefined;
const ssoSecretBox = (): SecretBox => {
  const configured = process.env.SSO_SECRET_KEY?.trim() ?? "";
  const previous = process.env.SSO_SECRET_PREVIOUS_KEYS?.trim() ?? "";
  const source = `${configured}|${previous}`;
  if (cachedBox?.source === source) return cachedBox.box;
  let key: Buffer;
  if (configured) {
    key = parseEncryptionKey(configured);
  } else if (process.env.NODE_ENV === "production") {
    throw new SsoNotConfiguredError("SSO_SECRET_KEY must be configured in production");
  } else {
    const seed = process.env.JWT_SECRET || process.env.SECRET_KEY || "rfpilot-development-sso";
    key = crypto.createHash("sha256").update(`rfpilot-sso-dev-key:${seed}`).digest();
  }
  const previousKeys = previous ? previous.split(",").filter((value) => value.trim()).map(parseEncryptionKey) : [];
  cachedBox = { source, box: createSecretBox(key, previousKeys) };
  return cachedBox.box;
};
const secretContext = (organizationId: string) => `sso-connection:${organizationId}`;

/* Where identity providers send the browser back. Must be registered with each IdP exactly. */
export const ssoRedirectUri = () => {
  const explicit = process.env.SSO_CALLBACK_URL?.trim();
  if (explicit) return explicit;
  const base = (process.env.BACKEND_URL || process.env.API_URL || "http://localhost:8000").split(",")[0].trim().replace(/\/+$/, "");
  return `${base}/api/auth/sso/callback`;
};

/* Where the browser lands after the callback: the dashboard. */
export const dashboardUrl = () => (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim().replace(/\/+$/, "");

const microsoftConfig = () => {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

/* http:// issuers are accepted only for localhost, and only outside production (a local mock IdP). */
const allowInsecureLocalhost = () => process.env.NODE_ENV !== "production";

/* The Microsoft "common" metadata is pinned so a misconfigured env can't point it elsewhere;
   tests replace the whole oidc dependency instead. */
const oidc = { discover, authorizationUrl, exchangeCode, verifyIdToken };

const randomPasswordHash = async () => bcryptPasswordHasher.hash(crypto.randomBytes(32).toString("base64url"));

export const federatedSignIn = createFederatedSignIn({
  store: ssoStateStore(),
  oidc,
  microsoft: microsoftConfig,
  redirectUri: ssoRedirectUri,
  connections: createMongoConnectionLookup((sealed, organizationId) => ssoSecretBox().open(sealed, secretContext(organizationId))),
  accounts: createMongoFederatedAccounts(randomPasswordHash),
  ssoRequiredFor: mongoSsoRequiredFor,
  invitations: {
    organizationOf: (token) => invitations.service.organizationOfToken(token),
    async acceptWithPerson(token, person, method, correlationId) {
      const outcome = await invitations.service.acceptWithVerifiedIdentity(
        token,
        {
          email: person.email,
          name: person.name,
          avatar: person.avatar,
          federatedIdentity: { provider: person.provider, issuer: person.issuer, subject: person.subject },
        },
        method,
        correlationId,
      );
      if (outcome.kind === "accepted") {
        return { kind: "accepted", userId: outcome.userId, organizationId: outcome.organizationId, role: outcome.role };
      }
      const codes: Record<string, string> = {
        email_mismatch: "INVITATION_EMAIL_MISMATCH",
        blocked: "USER_BLOCKED",
        sso_required: "SSO_REQUIRED",
        account_exists: "ACCOUNT_EXISTS",
        invalid_identity: "SSO_IDENTITY_INVALID",
      };
      const code = "code" in outcome && typeof outcome.code === "string" ? outcome.code : codes[outcome.kind] ?? "INVITATION_ERROR";
      return { kind: "refused", code };
    },
  },
  audit: (event) => mongoSecurityAuditWriter.append({
    organizationId: event.organizationId,
    actorUserId: event.userId,
    action: event.action,
    targetType: "user",
    targetId: event.userId,
    decision: "created",
    reason: event.reason,
    correlationId: event.correlationId,
    metadata: event.metadata,
  }),
});

export const manageSsoConnection = createManageSsoConnection({
  connections: mongoSsoConnectionRepository,
  organizations: mongoSsoOrganizations,
  discover: (issuer) => discover(issuer),
  async fetchKeys(jwksUri) {
    const response = await fetch(jwksUri, { signal: AbortSignal.timeout(8_000), redirect: "error" });
    const body = (await response.json().catch(() => null)) as { keys?: unknown[] } | null;
    // Also warms jose's cache for the first real sign-in.
    createRemoteJWKSet(new URL(jwksUri));
    return response.ok && Array.isArray(body?.keys) ? body.keys.length : 0;
  },
  seal: (secret, organizationId) => ssoSecretBox().seal(secret, secretContext(organizationId)),
  redirectUri: ssoRedirectUri,
  allowInsecureLocalhost,
  revokeMemberSessions: (input) => authenticationSessions.revokeAll(input),
  audit: (event) => mongoSecurityAuditWriter.append({
    organizationId: event.organizationId,
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: "organization",
    targetId: event.organizationId,
    decision: "allowed",
    reason: event.reason,
    correlationId: event.correlationId,
    metadata: event.metadata,
  }),
  now: () => new Date(),
});
