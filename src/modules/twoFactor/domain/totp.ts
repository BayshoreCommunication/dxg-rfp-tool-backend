import crypto from "node:crypto";

/* RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30-second steps), the profile every
   authenticator app supports. Implemented on node:crypto rather than a library:
   it is ~40 lines and the RFC test vectors pin it (tests/two-factor-totp.test.js). */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const base32Encode = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

export const base32Decode = (input: string): Buffer => {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
};

/** A new 160-bit secret, the RFC 4226 recommended length, base32 encoded. */
export const generateTotpSecret = (): string => base32Encode(crypto.randomBytes(20));

export const totpStep = (at: Date): number => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);

export const hotp = (secret: Buffer, counter: number, digits = TOTP_DIGITS): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, "0");
};

export const totpAt = (base32Secret: string, at: Date, digits = TOTP_DIGITS): string =>
  hotp(base32Decode(base32Secret), totpStep(at), digits);

/**
 * The step the code matches, searching one step either side for clock drift, or
 * null. Callers refuse a matched step at or below the last one accepted, which is
 * what makes a code single-use.
 */
export const matchTotpStep = (base32Secret: string, code: string, at: Date, window = 1): number | null => {
  const normalized = String(code ?? "").replace(/\s/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return null;
  const secret = base32Decode(base32Secret);
  const current = totpStep(at);
  const presented = Buffer.from(normalized);
  let matched: number | null = null;
  // Check every candidate so timing doesn't reveal which step matched.
  for (let step = current - window; step <= current + window; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, presented) && matched === null) matched = step;
  }
  return matched;
};

export const otpauthUri = (input: { issuer: string; accountName: string; secret: string }): string => {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};
