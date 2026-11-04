const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { base32Decode, base32Encode, hotp, matchTotpStep, otpauthUri, totpAt, totpStep, generateTotpSecret } = require("../src/modules/twoFactor/domain/totp");
const { createSecretBox, parseEncryptionKey } = require("../src/shared/security/secretBox");

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890", 8 digits.
const RFC_SECRET = Buffer.from("12345678901234567890");
for (const [seconds, expected] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"]]) {
  test(`RFC 6238 vector at T=${seconds}`, () => {
    assert.equal(hotp(RFC_SECRET, Math.floor(seconds / 30), 8), expected);
  });
}

test("base32 round-trips and matches the RFC 4648 alphabet", () => {
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.deepEqual(base32Decode("mzxw 6ytb-oi=="), Buffer.from("foobar"));
  const random = crypto.randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(random)), random);
  assert.throws(() => base32Decode("not-base32!"));
});

test("generated secrets are 160-bit base32", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);
});

test("a code matches its own step and one step of drift either side, not two", () => {
  const secret = generateTotpSecret();
  const at = new Date("2026-11-02T12:00:10Z");
  const step = totpStep(at);
  assert.equal(matchTotpStep(secret, totpAt(secret, at), at), step);
  assert.equal(matchTotpStep(secret, totpAt(secret, new Date(at.getTime() - 30_000)), at), step - 1);
  assert.equal(matchTotpStep(secret, totpAt(secret, new Date(at.getTime() + 30_000)), at), step + 1);
  assert.equal(matchTotpStep(secret, totpAt(secret, new Date(at.getTime() - 61_000)), at), null);
  assert.equal(matchTotpStep(secret, "12345", at), null);
  assert.equal(matchTotpStep(secret, "abcdef", at), null);
  assert.equal(matchTotpStep(secret, undefined, at), null);
});

test("the otpauth URI carries issuer, account and the TOTP profile", () => {
  const uri = otpauthUri({ issuer: "RFPilot", accountName: "planner@example.com", secret: "JBSWY3DPEHPK3PXP" });
  assert.ok(uri.startsWith("otpauth://totp/RFPilot:planner%40example.com?"));
  const params = new URL(uri).searchParams;
  assert.equal(params.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(params.get("issuer"), "RFPilot");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
  assert.equal(params.get("algorithm"), "SHA1");
});

test("the secret box round-trips and binds the ciphertext to its context", () => {
  const box = createSecretBox(crypto.randomBytes(32));
  const sealed = box.seal("JBSWY3DPEHPK3PXP", "user-1");
  assert.ok(!sealed.includes("JBSWY3DPEHPK3PXP"));
  assert.notEqual(box.seal("JBSWY3DPEHPK3PXP", "user-1"), sealed, "random IV");
  assert.equal(box.open(sealed, "user-1"), "JBSWY3DPEHPK3PXP");
  assert.throws(() => box.open(sealed, "user-2"), "moved onto another user");
  const parts = sealed.split(".");
  parts[4] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => box.open(parts.join("."), "user-1"));
  assert.throws(() => createSecretBox(crypto.randomBytes(32)).open(sealed, "user-1"), /unknown key/);
});

test("a previous key still opens old ciphertexts after rotation", () => {
  const oldKey = crypto.randomBytes(32);
  const sealed = createSecretBox(oldKey).seal("seed", "u");
  assert.equal(createSecretBox(crypto.randomBytes(32), [oldKey]).open(sealed, "u"), "seed");
});

test("encryption keys must be 32 bytes in hex or base64", () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(parseEncryptionKey(key.toString("hex")), key);
  assert.deepEqual(parseEncryptionKey(key.toString("base64")), key);
  assert.throws(() => parseEncryptionKey("short"));
});
