import crypto from "node:crypto";
import Redis from "ioredis";
import { assistantRuntimeConfig, type AssistantRuntimeConfig } from "./config";
import {
  PlatformAssistantError,
  type PlatformAssistantContext,
} from "./domain";

type RedisEvalClient = {
  status?: string;
  connect?: () => Promise<unknown>;
  eval(
    script: string,
    keyCount: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
};

type RateBucket = { count: number; resetAt: number };

export type AssistantLimitLease = {
  release(): Promise<void>;
};

export interface AssistantOperationalLimiter {
  acquire(context: PlatformAssistantContext): Promise<AssistantLimitLease>;
}

const digest = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

export const assistantLimitKeys = (context: PlatformAssistantContext) => {
  const organization = digest(context.organizationMongoId);
  const user = digest(
    `${context.organizationMongoId}:${context.actorUserMongoId}`,
  );
  return {
    userRate: `rfpilot:assistant:rate:user:${user}`,
    organizationRate: `rfpilot:assistant:rate:org:${organization}`,
    userActive: `rfpilot:assistant:active:user:${user}`,
    organizationActive: `rfpilot:assistant:active:org:${organization}`,
  };
};

const acquireScript = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local userRateLimit = tonumber(ARGV[3])
local organizationRateLimit = tonumber(ARGV[4])
local userActiveLimit = tonumber(ARGV[5])
local organizationActiveLimit = tonumber(ARGV[6])
local leaseExpiresAt = tonumber(ARGV[7])
local leaseToken = ARGV[8]

redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
local userActive = redis.call('ZCARD', KEYS[3])
local organizationActive = redis.call('ZCARD', KEYS[4])
if userActive >= userActiveLimit then
  local nearest = redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')
  local retry = nearest[2] and math.max(1, math.ceil((tonumber(nearest[2]) - now) / 1000)) or 1
  return {'concurrency_user', tostring(retry)}
end
if organizationActive >= organizationActiveLimit then
  local nearest = redis.call('ZRANGE', KEYS[4], 0, 0, 'WITHSCORES')
  local retry = nearest[2] and math.max(1, math.ceil((tonumber(nearest[2]) - now) / 1000)) or 1
  return {'concurrency_organization', tostring(retry)}
end

local userRate = tonumber(redis.call('GET', KEYS[1]) or '0')
local organizationRate = tonumber(redis.call('GET', KEYS[2]) or '0')
if userRate >= userRateLimit then
  local ttl = redis.call('PTTL', KEYS[1])
  return {'rate_user', tostring(math.max(1, math.ceil((ttl > 0 and ttl or window) / 1000)))}
end
if organizationRate >= organizationRateLimit then
  local ttl = redis.call('PTTL', KEYS[2])
  return {'rate_organization', tostring(math.max(1, math.ceil((ttl > 0 and ttl or window) / 1000)))}
end

local nextUserRate = redis.call('INCR', KEYS[1])
if nextUserRate == 1 then redis.call('PEXPIRE', KEYS[1], window) end
local nextOrganizationRate = redis.call('INCR', KEYS[2])
if nextOrganizationRate == 1 then redis.call('PEXPIRE', KEYS[2], window) end
redis.call('ZADD', KEYS[3], leaseExpiresAt, leaseToken)
redis.call('ZADD', KEYS[4], leaseExpiresAt, leaseToken)
redis.call('PEXPIRE', KEYS[3], leaseExpiresAt - now + 1000)
redis.call('PEXPIRE', KEYS[4], leaseExpiresAt - now + 1000)
return {'ok', '0'}
`;

const releaseScript = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
if redis.call('ZCARD', KEYS[2]) == 0 then redis.call('DEL', KEYS[2]) end
return 1
`;

const parseRedisResult = (
  value: unknown,
): { outcome: string; retryAfterSeconds: number } => {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    throw new Error("Invalid assistant limit response");
  }
  const retryAfterSeconds = Math.max(0, Number(value[1]) || 0);
  return { outcome: value[0], retryAfterSeconds };
};

const limitError = (
  outcome: string,
  retryAfterSeconds: number,
): PlatformAssistantError => {
  const concurrency = outcome.startsWith("concurrency");
  return new PlatformAssistantError(
    concurrency
      ? "ASSISTANT_CONCURRENCY_LIMITED"
      : "ASSISTANT_RATE_LIMITED",
    concurrency
      ? "Another assistant response is already active. Please wait for it to finish."
      : "Too many assistant requests. Please try again later.",
    429,
    true,
    Math.max(1, retryAfterSeconds),
  );
};

export class MemoryAssistantLimitStore {
  readonly rates = new Map<string, RateBucket>();
  readonly active = new Map<string, Map<string, number>>();

  acquire(
    keys: ReturnType<typeof assistantLimitKeys>,
    token: string,
    now: number,
    config: AssistantRuntimeConfig,
  ): void {
    const prune = (key: string) => {
      const leases = this.active.get(key);
      if (!leases) return;
      for (const [existingToken, expiresAt] of leases) {
        if (expiresAt <= now) leases.delete(existingToken);
      }
      if (leases.size === 0) this.active.delete(key);
    };
    prune(keys.userActive);
    prune(keys.organizationActive);
    const userActive = this.active.get(keys.userActive);
    const organizationActive = this.active.get(keys.organizationActive);
    if ((userActive?.size ?? 0) >= config.maxActiveStreamsPerUser) {
      const nearest = Math.min(...(userActive?.values() ?? []));
      throw limitError(
        "concurrency_user",
        Math.ceil((nearest - now) / 1_000),
      );
    }
    if (
      (organizationActive?.size ?? 0) >=
      config.maxActiveStreamsPerOrganization
    ) {
      const nearest = Math.min(...(organizationActive?.values() ?? []));
      throw limitError(
        "concurrency_organization",
        Math.ceil((nearest - now) / 1_000),
      );
    }

    const bucket = (key: string): RateBucket => {
      const current = this.rates.get(key);
      return !current || current.resetAt <= now
        ? { count: 0, resetAt: now + config.rateWindowMs }
        : current;
    };
    const userRate = bucket(keys.userRate);
    const organizationRate = bucket(keys.organizationRate);
    if (userRate.count >= config.requestsPerWindow) {
      throw limitError(
        "rate_user",
        Math.ceil((userRate.resetAt - now) / 1_000),
      );
    }
    if (organizationRate.count >= config.organizationRequestsPerWindow) {
      throw limitError(
        "rate_organization",
        Math.ceil((organizationRate.resetAt - now) / 1_000),
      );
    }
    this.rates.set(keys.userRate, {
      ...userRate,
      count: userRate.count + 1,
    });
    this.rates.set(keys.organizationRate, {
      ...organizationRate,
      count: organizationRate.count + 1,
    });
    const expiresAt = now + config.activeLeaseMs;
    const add = (key: string) => {
      const leases = this.active.get(key) ?? new Map<string, number>();
      leases.set(token, expiresAt);
      this.active.set(key, leases);
    };
    add(keys.userActive);
    add(keys.organizationActive);
  }

  release(keys: ReturnType<typeof assistantLimitKeys>, token: string): void {
    for (const key of [keys.userActive, keys.organizationActive]) {
      const leases = this.active.get(key);
      if (!leases) continue;
      leases.delete(token);
      if (leases.size === 0) this.active.delete(key);
    }
  }
}

export const createAssistantOperationalLimiter = (options?: {
  redis?: RedisEvalClient | null;
  memory?: MemoryAssistantLimitStore;
  now?: () => number;
  config?: () => AssistantRuntimeConfig;
}): AssistantOperationalLimiter => {
  const memory = options?.memory ?? new MemoryAssistantLimitStore();
  const now = options?.now ?? Date.now;
  const configured = options?.config ?? assistantRuntimeConfig;
  let redis = options?.redis;
  let resolvedRedis = options ? true : false;

  const redisClient = (): RedisEvalClient | null => {
    if (resolvedRedis) return redis ?? null;
    resolvedRedis = true;
    const url = process.env.REDIS_URL;
    if (!url) {
      redis = null;
      return null;
    }
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on("error", () => undefined);
    redis = client;
    return client;
  };

  return {
    async acquire(context) {
      const config = configured();
      const keys = assistantLimitKeys(context);
      const token = crypto.randomUUID();
      const acquiredAt = now();
      const client = redisClient();
      if (client) {
        try {
          if (client.status === "wait" && client.connect) {
            await client.connect();
          }
          const raw = await client.eval(
            acquireScript,
            4,
            keys.userRate,
            keys.organizationRate,
            keys.userActive,
            keys.organizationActive,
            acquiredAt,
            config.rateWindowMs,
            config.requestsPerWindow,
            config.organizationRequestsPerWindow,
            config.maxActiveStreamsPerUser,
            config.maxActiveStreamsPerOrganization,
            acquiredAt + config.activeLeaseMs,
            token,
          );
          const result = parseRedisResult(raw);
          if (result.outcome !== "ok") {
            throw limitError(result.outcome, result.retryAfterSeconds);
          }
          let released = false;
          return {
            async release() {
              if (released) return;
              released = true;
              await client
                .eval(
                  releaseScript,
                  2,
                  keys.userActive,
                  keys.organizationActive,
                  token,
                )
                .catch(() => undefined);
            },
          };
        } catch (error) {
          if (error instanceof PlatformAssistantError) throw error;
          // Preserve availability during a transient Redis outage while still
          // enforcing a bounded per-instance fallback.
        }
      }

      memory.acquire(keys, token, acquiredAt, config);
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          memory.release(keys, token);
        },
      };
    },
  };
};

export const assistantOperationalLimiter = createAssistantOperationalLimiter();
