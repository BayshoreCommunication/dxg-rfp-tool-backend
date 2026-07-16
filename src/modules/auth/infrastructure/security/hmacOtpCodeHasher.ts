import crypto from "node:crypto";
import type { OtpCodeHasher } from "../../domain/ports/otpPorts";

const configuredPepper = () => {
  const pepper = process.env.OTP_PEPPER || process.env.JWT_SECRET || process.env.SECRET_KEY;
  if (!pepper && process.env.NODE_ENV === "production") {
    throw new Error("OTP_PEPPER must be configured in production");
  }
  return pepper || "rfpilot-development-otp-pepper";
};
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
