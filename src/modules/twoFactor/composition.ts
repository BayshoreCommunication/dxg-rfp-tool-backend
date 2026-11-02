import crypto from "node:crypto";
import Organization from "../../../modal/organizationModel";
import { createSecretBox, parseEncryptionKey, type SecretBox } from "../../shared/security/secretBox";
import { hmacOtpCodeHasher } from "../auth/infrastructure/security/hmacOtpCodeHasher";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { authenticationSessions } from "../auth/composition";
import { createTwoFactorService } from "./application/manageTwoFactor";
import { ssoPolicyFromEnv } from "./domain/secondFactorPolicy";
import { mongoTwoFactorChallengeRepository, mongoTwoFactorRepository } from "./infrastructure/mongo/mongoTwoFactorRepository";

export class TwoFactorNotConfiguredError extends Error {}

/* TWO_FACTOR_ENCRYPTION_KEY seals TOTP seeds. Production refuses to run 2FA
   without it. Elsewhere a key is derived from JWT_SECRET so local development
   and tests work without extra setup; those seeds are not production data. */
let cachedBox: { source: string; box: SecretBox } | undefined;
export const twoFactorSecretBox = (): SecretBox => {
  const configured = process.env.TWO_FACTOR_ENCRYPTION_KEY?.trim() ?? "";
  const previous = process.env.TWO_FACTOR_ENCRYPTION_PREVIOUS_KEYS?.trim() ?? "";
  const source = `${configured}|${previous}`;
  if (cachedBox?.source === source) return cachedBox.box;
  let key: Buffer;
  if (configured) {
    key = parseEncryptionKey(configured);
  } else if (process.env.NODE_ENV === "production") {
    throw new TwoFactorNotConfiguredError("TWO_FACTOR_ENCRYPTION_KEY must be configured in production");
  } else {
    const seed = process.env.JWT_SECRET || process.env.SECRET_KEY || "rfpilot-development-two-factor";
    key = crypto.createHash("sha256").update(`rfpilot-two-factor-dev-key:${seed}`).digest();
  }
  const previousKeys = previous ? previous.split(",").filter((value) => value.trim()).map(parseEncryptionKey) : [];
  cachedBox = { source, box: createSecretBox(key, previousKeys) };
  return cachedBox.box;
};

export const organizationRequiresTwoFactor = async (organizationId: string): Promise<boolean> => {
  const organization = await Organization.findById(organizationId).select("requireTwoFactor").lean<{ requireTwoFactor?: boolean } | null>();
  return Boolean(organization?.requireTwoFactor);
};

export const twoFactor = createTwoFactorService({
  records: mongoTwoFactorRepository,
  challenges: mongoTwoFactorChallengeRepository,
  secretBox: twoFactorSecretBox,
  hasher: hmacOtpCodeHasher,
  audit: mongoSecurityAuditWriter,
  organizationRequiresTwoFactor,
  // The session hook for ORG-307. Until that ticket centralises membership-change
  // revocation, a reset revokes every refresh session the member holds in this org.
  revokeMemberSessions: (input) => authenticationSessions.revokeAll(input),
  ssoPolicy: () => ssoPolicyFromEnv(),
  issuer: process.env.TWO_FACTOR_ISSUER?.trim() || "RFPilot",
});
