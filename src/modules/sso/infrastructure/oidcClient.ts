import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ProviderMetadata } from "../domain/ports";
import type { IdTokenClaims } from "../domain/ssoRules";

/* A minimal OpenID Connect relying party: discovery, the authorization-code flow with
   PKCE (S256), and ID-token verification against the provider's published keys. Only
   what Microsoft and company IdPs (Okta, Entra, Google Workspace, ...) need. */

export type { ProviderMetadata };

export class OidcError extends Error {
  constructor(readonly code: "DISCOVERY_FAILED" | "TOKEN_EXCHANGE_FAILED" | "ID_TOKEN_INVALID", message: string) {
    super(message);
  }
}

const TIMEOUT_MS = 8_000;
const DISCOVERY_TTL_MS = 60 * 60_000;
const discoveryCache = new Map<string, { at: number; metadata: ProviderMetadata }>();
const jwksCache = new Map<string, JWTVerifyGetKey>();

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  const body = await response.json().catch(() => null);
  return { response, body: body as Record<string, unknown> | null };
};

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/* `expectedIssuer` is what the discovery document must declare. Microsoft's multi-tenant
   document declares the "{tenantid}" template, so its caller passes that literal. */
export const discover = async (discoveryIssuer: string, expectedIssuer = discoveryIssuer): Promise<ProviderMetadata> => {
  const cached = discoveryCache.get(discoveryIssuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.metadata;
  const url = `${discoveryIssuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let body: Record<string, unknown> | null;
  try {
    const result = await fetchJson(url);
    if (!result.response.ok) throw new Error(`status ${result.response.status}`);
    body = result.body;
  } catch (error) {
    throw new OidcError("DISCOVERY_FAILED", `Discovery failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (!body || body.issuer !== expectedIssuer) {
    throw new OidcError("DISCOVERY_FAILED", "Discovery document issuer does not match");
  }
  if (![body.authorization_endpoint, body.token_endpoint, body.jwks_uri].every(isHttpUrl)) {
    throw new OidcError("DISCOVERY_FAILED", "Discovery document is missing endpoints");
  }
  const metadata = {
    issuer: body.issuer as string,
    authorization_endpoint: body.authorization_endpoint as string,
    token_endpoint: body.token_endpoint as string,
    jwks_uri: body.jwks_uri as string,
  };
  discoveryCache.set(discoveryIssuer, { at: Date.now(), metadata });
  return metadata;
};

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const pkceChallenge = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");

export const authorizationUrl = (metadata: ProviderMetadata, input: {
  clientId: string; redirectUri: string; state: string; nonce: string; codeVerifier: string; loginHint?: string;
  extra?: Record<string, string>;
}) => {
  const url = new URL(metadata.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: "openid email profile",
    state: input.state,
    nonce: input.nonce,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: "S256",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
    ...input.extra,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

export const exchangeCode = async (metadata: ProviderMetadata, input: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string;
}): Promise<string> => {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });
  let result;
  try {
    result = await fetchJson(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
  } catch (error) {
    throw new OidcError("TOKEN_EXCHANGE_FAILED", `Token request failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  const idToken = result.body?.id_token;
  if (!result.response.ok || typeof idToken !== "string") {
    // The provider's error code only (never the body, which can echo the code).
    const reason = typeof result.body?.error === "string" ? result.body.error : `status ${result.response.status}`;
    throw new OidcError("TOKEN_EXCHANGE_FAILED", `Token request refused: ${reason}`);
  }
  return idToken;
};

const keysFor = (jwksUri: string) => {
  let keys = jwksCache.get(jwksUri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: TIMEOUT_MS, cooldownDuration: 30_000 });
    jwksCache.set(jwksUri, keys);
  }
  return keys;
};

/* Signature, audience, expiry and nonce always. The issuer is either a fixed value or, for
   Microsoft, computed from the token's own tenant claim by `issuerFor`. */
export const verifyIdToken = async (metadata: ProviderMetadata, idToken: string, input: {
  clientId: string; nonce: string; issuer?: string; issuerFor?: (claims: Record<string, unknown>) => string | null;
}): Promise<IdTokenClaims> => {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, keysFor(metadata.jwks_uri), {
      audience: input.clientId,
      clockTolerance: 60,
      algorithms: ["RS256", "RS384", "RS512", "PS256", "ES256", "ES384"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    throw new OidcError("ID_TOKEN_INVALID", `ID token rejected: ${error instanceof Error ? error.name : "unknown"}`);
  }
  const expectedIssuer = input.issuer ?? input.issuerFor?.(payload) ?? null;
  if (!expectedIssuer || payload.iss !== expectedIssuer) throw new OidcError("ID_TOKEN_INVALID", "ID token issuer does not match");
  if (typeof payload.nonce !== "string" || payload.nonce.length !== input.nonce.length
    || !crypto.timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(input.nonce))) {
    throw new OidcError("ID_TOKEN_INVALID", "ID token nonce does not match");
  }
  if (typeof payload.sub !== "string" || !payload.sub) throw new OidcError("ID_TOKEN_INVALID", "ID token has no subject");
  return payload as IdTokenClaims;
};

/** For tests: forget cached discovery documents and key sets. */
export const clearOidcCaches = () => {
  discoveryCache.clear();
  jwksCache.clear();
};
