import crypto from "node:crypto";

/* Authenticated encryption for small secrets stored at rest (ORG-303: TOTP seeds).
   AES-256-GCM with a random 96-bit IV. The caller passes a context string (for
   example the owning user id) that is bound as additional authenticated data, so
   a ciphertext copied onto another record fails to decrypt instead of working.

   Envelope: v1.<keyId>.<iv>.<tag>.<ciphertext>, each part base64url. keyId is a
   short fingerprint of the key, which lets a previous key keep decrypting old
   rows while the current key encrypts new ones (rotation without a migration). */

export type SecretBox = {
  seal(plaintext: string, context: string): string;
  open(envelope: string, context: string): string;
};

const VERSION = "v1";

export const parseEncryptionKey = (value: string): Buffer => {
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes, as 64 hex characters or base64");
  return key;
};

const fingerprint = (key: Buffer) =>
  crypto.createHash("sha256").update(key).digest("base64url").slice(0, 8);

export const createSecretBox = (currentKey: Buffer, previousKeys: Buffer[] = []): SecretBox => {
  const keys = new Map<string, Buffer>();
  for (const key of [currentKey, ...previousKeys]) keys.set(fingerprint(key), key);
  const currentId = fingerprint(currentKey);
  return {
    seal(plaintext, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", currentKey, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, currentId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
    },
    open(envelope, context) {
      const [version, keyId, iv, tag, ciphertext, ...rest] = envelope.split(".");
      if (version !== VERSION || rest.length || !keyId || !iv || !tag || ciphertext === undefined) {
        throw new Error("Unrecognised secret envelope");
      }
      const key = keys.get(keyId);
      if (!key) throw new Error("Secret was sealed with an unknown key");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
  };
};
