import type {
  SupportPresenceEntry,
  SupportPresenceStore,
} from "../../domain/ports/supportDeskPorts";
import { supportRedis } from "../redis/supportRedis";

// The whole set expires shortly after the last heartbeat; individual stale
// entries are filtered out by the application on read.
const KEY_TTL_MS = 60_000;
const key = (organizationId: string, ticketId: string) => `support:presence:${organizationId}:${ticketId}`;

const parse = (raw: string): SupportPresenceEntry | null => {
  try {
    const value = JSON.parse(raw) as SupportPresenceEntry;
    return typeof value.userId === "string" && typeof value.at === "string" ? value : null;
  } catch {
    return null;
  }
};

const memory = new Map<string, Map<string, SupportPresenceEntry>>();

const memoryStore: SupportPresenceStore = {
  async touch(organizationId, ticketId, entry) {
    const entries = memory.get(key(organizationId, ticketId)) ?? new Map();
    entries.set(entry.userId, entry);
    memory.set(key(organizationId, ticketId), entries);
  },
  async list(organizationId, ticketId) {
    return [...(memory.get(key(organizationId, ticketId))?.values() ?? [])];
  },
  async remove(organizationId, ticketId, userId) {
    memory.get(key(organizationId, ticketId))?.delete(userId);
  },
};

/** Redis-backed so every API instance sees the same agents; in-memory without Redis. */
export const supportPresenceStore: SupportPresenceStore = {
  async touch(organizationId, ticketId, entry) {
    const redis = supportRedis();
    if (!redis) return memoryStore.touch(organizationId, ticketId, entry);
    const k = key(organizationId, ticketId);
    await redis.multi().hset(k, entry.userId, JSON.stringify(entry)).pexpire(k, KEY_TTL_MS).exec();
  },
  async list(organizationId, ticketId) {
    const redis = supportRedis();
    if (!redis) return memoryStore.list(organizationId, ticketId);
    const raw = await redis.hgetall(key(organizationId, ticketId));
    return Object.values(raw).map(parse).filter((entry): entry is SupportPresenceEntry => entry !== null);
  },
  async remove(organizationId, ticketId, userId) {
    const redis = supportRedis();
    if (!redis) return memoryStore.remove(organizationId, ticketId, userId);
    await redis.hdel(key(organizationId, ticketId), userId);
  },
};
