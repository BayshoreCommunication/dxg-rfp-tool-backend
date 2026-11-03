import crypto from "node:crypto";

/* What a successful primary sign-in must do next (ORG-303, ORG-304).

   DXG question Q8 (does Google/Microsoft sign-in satisfy an organization's
   mandatory 2FA?) is open. The spec's default until it is answered: SSO sign-ins
   are still challenged. TWO_FACTOR_SSO_POLICY is the one switch:
     challenge (default)  SSO is treated exactly like a password sign-in
     trust_sso            SSO sign-ins skip the second factor entirely

   company_sso is a sign-in through the organization's own identity provider. That
   IdP owns MFA for those, so they never get our prompt (DXG decision 2026-11-03),
   whatever TWO_FACTOR_SSO_POLICY says. */

export type PrimaryMethod = "password" | "sso" | "company_sso";
export type SsoPolicy = "challenge" | "trust_sso";
export type SecondFactorStep = "none" | "challenge" | "enrol";

export const ssoPolicyFromEnv = (value = process.env.TWO_FACTOR_SSO_POLICY): SsoPolicy =>
  value?.trim().toLowerCase() === "trust_sso" ? "trust_sso" : "challenge";

export const decideSecondFactor = (input: {
  enrolled: boolean;
  organizationRequiresTwoFactor: boolean;
  method: PrimaryMethod;
  ssoPolicy: SsoPolicy;
}): SecondFactorStep => {
  if (input.method === "company_sso") return "none";
  if (input.method === "sso" && input.ssoPolicy === "trust_sso") return "none";
  if (input.enrolled) return "challenge";
  if (input.organizationRequiresTwoFactor) return "enrol";
  return "none";
};

/* Re-authentication for turning 2FA off. A password, when one is given, must match. An
   SSO-linked account may have no password its owner knows (Google sign-up stores a random
   one), so without a password the current TOTP or recovery code the disable already
   demands is the proof. Accounts that aren't SSO-linked always need the password. */
export type Reauthentication = "password" | "second_factor" | "refused";
export const reauthenticationForDisable = (input: { passwordSupplied: boolean; passwordMatches: boolean; ssoLinked: boolean }): Reauthentication => {
  if (input.passwordSupplied) return input.passwordMatches ? "password" : "refused";
  return input.ssoLinked ? "second_factor" : "refused";
};

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

/** Ten codes like `k7mq-x2dr-p9fh` (12 characters from 31: about 59 bits each), shown once and stored hashed. */
export const generateRecoveryCodes = (count = RECOVERY_CODE_COUNT): string[] =>
  Array.from({ length: count }, () => {
    const chars = Array.from({ length: 12 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]);
    return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((part) => part.join("")).join("-");
  });

export const normalizeRecoveryCode = (code: string): string =>
  String(code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
