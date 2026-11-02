import crypto from "node:crypto";

/* What a successful primary sign-in must do next (ORG-303, ORG-304).

   DXG question Q8 (does Google/Microsoft sign-in satisfy an organization's
   mandatory 2FA?) is open. The spec's default until it is answered: SSO sign-ins
   are still challenged. TWO_FACTOR_SSO_POLICY is the one switch:
     challenge (default)  SSO is treated exactly like a password sign-in
     trust_sso            SSO sign-ins skip the second factor entirely */

export type PrimaryMethod = "password" | "sso";
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
  if (input.method === "sso" && input.ssoPolicy === "trust_sso") return "none";
  if (input.enrolled) return "challenge";
  if (input.organizationRequiresTwoFactor) return "enrol";
  return "none";
};

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

/** Ten codes like `k7mq-x2dr-p9fh` (about 74 bits each), shown once and stored hashed. */
export const generateRecoveryCodes = (count = RECOVERY_CODE_COUNT): string[] =>
  Array.from({ length: count }, () => {
    const chars = Array.from({ length: 12 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]);
    return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((part) => part.join("")).join("-");
  });

export const normalizeRecoveryCode = (code: string): string =>
  String(code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
