import Redis from "ioredis";

let client: Redis | null | undefined;

/**
 * One shared Redis connection for support-desk coordination (presence and
 * the sweeper lock). Null when REDIS_URL is not configured, e.g. a bare local
 * setup; callers then fall back to in-process behavior.
 */
export const supportRedis = (): Redis | null => {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  client = url ? new Redis(url, { maxRetriesPerRequest: 2 }) : null;
  client?.on("error", (error) => {
    console.error("Support desk Redis error:", error.message);
  });
  return client;
};
