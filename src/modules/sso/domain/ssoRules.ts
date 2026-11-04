/* Pure rules for federated sign-in (Microsoft and company OIDC). No I/O here. */

export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
// Personal Microsoft accounts (outlook.com, hotmail.com, live.com) all sign in through this tenant.
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export type FederatedKind = "microsoft" | "company";

/** The claims we use from a verified ID token. */
export type IdTokenClaims = Record<string, unknown> & { iss: string; sub: string };

/** A person the identity provider vouched for, ready to match against accounts. */
export type VerifiedPerson = {
  provider: "microsoft" | "company_oidc";
  issuer: string;
  subject: string;
  email: string;
  name: string;
  avatar?: string;
};

export type ClaimsRefusal = "EMAIL_MISSING" | "MICROSOFT_EMAIL_UNVERIFIED" | "COMPANY_EMAIL_UNVERIFIED";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
export const emailDomain = (email: string): string => email.slice(email.lastIndexOf("@") + 1);
export const isEmail = (value: string) => EMAIL.test(value);

const displayName = (claims: IdTokenClaims, email: string) => {
  const name = typeof claims.name === "string" ? claims.name.trim() : "";
  return (name || email.split("@")[0]).slice(0, 200);
};

/* Microsoft's issuer is per tenant (https://login.microsoftonline.com/{tid}/v2.0) even though
   we sign in through the multi-tenant "common" endpoint, so the issuer is checked against the
   token's own tid rather than a fixed value. */
export const microsoftIssuerFor = (tid: unknown): string | null =>
  typeof tid === "string" && /^[0-9a-f-]{36}$/i.test(tid) ? `${MICROSOFT_AUTHORITY}/${tid.toLowerCase()}/v2.0` : null;

/* nOAuth: in a work tenant, any admin can put any address in a user's `email`. Microsoft
   marks addresses whose domain the tenant has verified with the optional claim
   xms_edov=true; personal accounts' emails are verified by Microsoft itself. Anything
   else is refused rather than trusted, because we link accounts by email. */
export const personFromMicrosoftClaims = (claims: IdTokenClaims): VerifiedPerson | { refusal: ClaimsRefusal } => {
  const email = normalizeEmail(claims.email);
  if (!email || !isEmail(email)) return { refusal: "EMAIL_MISSING" };
  const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
  const verified = tid === MICROSOFT_CONSUMER_TENANT || claims.xms_edov === true || claims.xms_edov === "1" || claims.xms_edov === 1;
  if (!verified) return { refusal: "MICROSOFT_EMAIL_UNVERIFIED" };
  const oid = typeof claims.oid === "string" && claims.oid ? claims.oid : claims.sub;
  return {
    provider: "microsoft",
    issuer: MICROSOFT_AUTHORITY,
    // One person across every app registration: tenant + object id.
    subject: `${tid}:${oid}`,
    email,
    name: displayName(claims, email),
  };
};

/* A company IdP vouches for its own users. The address must be marked verified when the IdP
   says so either way (email_verified=false is a refusal); the domain check against the
   connection's verified domains happens in the application layer. */
export const personFromCompanyClaims = (claims: IdTokenClaims): VerifiedPerson | { refusal: ClaimsRefusal } => {
  const email = normalizeEmail(claims.email ?? claims.preferred_username ?? claims.upn);
  if (!email || !isEmail(email)) return { refusal: "EMAIL_MISSING" };
  if (claims.email_verified === false || claims.email_verified === "false") return { refusal: "COMPANY_EMAIL_UNVERIFIED" };
  return {
    provider: "company_oidc",
    issuer: claims.iss,
    subject: claims.sub,
    email,
    name: displayName(claims, email),
    avatar: typeof claims.picture === "string" ? claims.picture : undefined,
  };
};

/* An issuer an Admin may configure: https only (http only for localhost, so a local mock IdP
   works in development), no credentials, query or fragment. Trailing slashes are kept as
   typed because issuer comparison in OIDC is exact. */
export const parseIssuer = (value: unknown, allowInsecureLocalhost: boolean): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && local && url.protocol === "http:")) return null;
  return trimmed;
};

/** Domains a connection may claim: lowercase, unique, each verified by the organization. */
export const connectionDomains = (requested: unknown, verified: string[]): { domains: string[] } | { unverified: string[] } | null => {
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > 50) return null;
  const domains = [...new Set(requested.map((d) => (typeof d === "string" ? d.trim().toLowerCase() : "")))];
  if (domains.some((d) => !d)) return null;
  const allowed = new Set(verified.map((d) => d.toLowerCase()));
  const unverified = domains.filter((d) => !allowed.has(d));
  return unverified.length ? { unverified } : { domains };
};
