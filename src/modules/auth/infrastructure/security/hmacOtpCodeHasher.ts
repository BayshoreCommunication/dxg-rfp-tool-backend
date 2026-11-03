import crypto from "node:crypto";
import type { OtpCodeHasher } from "../../domain/ports/otpPorts";

/* Recovery codes and OTPs are HMACed under OTP_PEPPER. Production must set it: falling back
   to JWT_SECRET would tie two secrets together, so a rotation of one silently changes the
   other. Development and tests keep the fallback. */
export const resolveOtpPepper = (env: NodeJS.ProcessEnv = process.env): string => {
  const pepper = env.OTP_PEPPER;
  if (pepper?.trim()) return pepper;
  if (env.NODE_ENV === "production") {
    throw new Error("OTP_PEPPER must be configured in production (see docs/runbooks/PRODUCTION.md)");
  }
  return env.JWT_SECRET || env.SECRET_KEY || "rfpilot-development-otp-pepper";
};

// Fail at startup, not on the first sign-in code.
resolveOtpPepper();

const configuredPepper = () => resolveOtpPepper();
const digest = (code: string) =>
  crypto.createHmac("sha256", configuredPepper()).update(code.trim(), "utf8").digest();

export const hmacOtpCodeHasher: OtpCodeHasher = {
  hash(code) {
    return digest(code).toString("hex");
  },
  matches(code, codeHash) {
    const expected = Buffer.from(codeHash, "hex");
    const actual = digest(code);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  },
};
