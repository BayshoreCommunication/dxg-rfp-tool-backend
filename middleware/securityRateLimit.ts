import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";
import Redis from "ioredis";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

// Counters are shared through Redis when REDIS_URL is configured so limits hold
// across PM2 cluster workers and serverless instances. The in-memory map is the
// fallback for local development and for transient Redis outages (fail open to
// per-instance limiting rather than taking the API down).
let redis: Redis | null | undefined;
const redisClient = (): Redis | null => {
  if (redis !== undefined) return redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    redis = null;
    return redis;
  }
  const client = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  client.on("error", () => {});
  redis = client;
  return redis;
};

const memoryHit = (key: string, windowMs: number, now: number): Bucket => {
  if (buckets.size > 10_000) {
    for (const [existingKey, value] of buckets) if (value.resetAt <= now) buckets.delete(existingKey);
  }
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + windowMs }
    : { ...current, count: current.count + 1 };
  buckets.set(key, bucket);
  return bucket;
};

const redisHit = async (client: Redis, key: string, windowMs: number, now: number): Promise<Bucket> => {
  const redisKey = `rfpilot:rate:${key}`;
  const count = await client.incr(redisKey);
  if (count === 1) await client.pexpire(redisKey, windowMs);
  const ttl = await client.pttl(redisKey);
  return { count, resetAt: now + (ttl > 0 ? ttl : windowMs) };
};

export const securityRateLimit = (options: {
  name: string; limit: number; windowMs: number;
  identity?: (req: Request) => string;
}) => (req: Request, res: Response, next: NextFunction): void => {
  const now = Date.now();
  const identity = options.identity?.(req) || req.ip || "unknown";
  const key = `${options.name}:${digest(identity)}`;
  const client = redisClient();
  const resolve = client
    ? redisHit(client, key, options.windowMs, now).catch(() => memoryHit(key, options.windowMs, now))
    : Promise.resolve(memoryHit(key, options.windowMs, now));
  resolve.then((bucket) => {
    res.setHeader("RateLimit-Limit", options.limit);
    res.setHeader("RateLimit-Remaining", Math.max(0, options.limit - bucket.count));
    res.setHeader("RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));
    if (bucket.count > options.limit) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
      return;
    }
    next();
  }).catch(() => next());
};

export const emailAndIpIdentity = (req: Request) =>
  `${req.ip}:${String(req.body?.email ?? "").toLowerCase().trim()}`;
export const grantAndIpIdentity = (req: Request) =>
  `${req.ip}:${String(req.query.accessGrant ?? req.body?.accessGrant ?? req.headers["x-rfpilot-access-grant"] ?? "")}`;
