import crypto from "node:crypto";
import Redis from "ioredis";
import type { SsoStateStore } from "../domain/ports";

/* Short-lived, single-use records for the federated sign-in round trip: the pending
   authorization (state → nonce, PKCE verifier, ...) and the handoff the dashboard
   exchanges for a session. Keys are stored hashed. Redis when REDIS_URL is set, so it
   works across PM2 workers; an in-memory map otherwise (local development and tests). */

export type { SsoStateStore };

const hashKey = (namespace: string, key: string) =>
  `rfpilot:sso:${namespace}:${crypto.createHash("sha256").update(key).digest("base64url")}`;

export const createMemorySsoStateStore = (now: () => number = Date.now): SsoStateStore => {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    async put(namespace, key, value, ttlMs) {
      if (entries.size > 10_000) for (const [k, e] of entries) if (e.expiresAt <= now()) entries.delete(k);
      entries.set(hashKey(namespace, key), { value: JSON.stringify(value), expiresAt: now() + ttlMs });
    },
    async take(namespace, key) {
      const id = hashKey(namespace, key);
      const entry = entries.get(id);
      entries.delete(id);
      if (!entry || entry.expiresAt <= now()) return null;
      return JSON.parse(entry.value);
    },
  };
};

export const createRedisSsoStateStore = (client: Redis): SsoStateStore => ({
  async put(namespace, key, value, ttlMs) {
    await client.set(hashKey(namespace, key), JSON.stringify(value), "PX", ttlMs);
  },
  async take(namespace, key) {
    // GETDEL is atomic: two concurrent callbacks can't both use one state or handoff.
    const raw = await client.getdel(hashKey(namespace, key));
    return raw ? JSON.parse(raw) : null;
  },
});

let shared: { store: SsoStateStore; client: Redis | null } | undefined;
export const ssoStateStore = (): SsoStateStore => {
  if (shared) return shared.store;
  const url = process.env.REDIS_URL;
  if (!url) {
    shared = { store: createMemorySsoStateStore(), client: null };
    return shared.store;
  }
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  client.on("error", () => {});
  shared = { store: createRedisSsoStateStore(client), client };
  return shared.store;
};

export const closeSsoStateStore = async (): Promise<void> => {
  const client = shared?.client;
  shared = undefined;
  if (client) await client.quit().catch(() => client.disconnect());
};
