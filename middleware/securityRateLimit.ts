import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export const securityRateLimit = (options: {
  name: string; limit: number; windowMs: number;
  identity?: (req: Request) => string;
}) => (req: Request, res: Response, next: NextFunction): void => {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
  }
  const identity = options.identity?.(req) || req.ip || "unknown";
  const key = `${options.name}:${digest(identity)}`;
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + options.windowMs }
    : { ...current, count: current.count + 1 };
  buckets.set(key, bucket);
  res.setHeader("RateLimit-Limit", options.limit);
  res.setHeader("RateLimit-Remaining", Math.max(0, options.limit - bucket.count));
  res.setHeader("RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));
  if (bucket.count > options.limit) {
    res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
    res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
    return;
  }
  next();
};

export const emailAndIpIdentity = (req: Request) =>
  `${req.ip}:${String(req.body?.email ?? "").toLowerCase().trim()}`;
export const grantAndIpIdentity = (req: Request) =>
  `${req.ip}:${String(req.query.accessGrant ?? req.body?.accessGrant ?? req.headers["x-rfpilot-access-grant"] ?? "")}`;
