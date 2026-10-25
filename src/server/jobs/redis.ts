import "server-only";
import IORedis, { type Redis } from "ioredis";

let shared: Redis | null | undefined;

export function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Create a BullMQ-compatible Redis connection (maxRetriesPerRequest must be null for workers).
 * Returns null when REDIS_URL is not configured.
 */
export function createRedisConnection(opts: { forWorker?: boolean } = {}): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new IORedis(url, {
    maxRetriesPerRequest: opts.forWorker ? null : 1,
    // Queue commands while the (lazy) connection is opening; callers bound waits with timeouts.
    enableOfflineQueue: true,
    lazyConnect: true,
    connectTimeout: 3000,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}

export function getSharedRedis(): Redis | null {
  if (shared === undefined) {
    shared = createRedisConnection();
    shared?.on("error", () => undefined); // surfaced through health checks instead of crashing
  }
  return shared;
}

export async function pingRedis(timeoutMs = 1500): Promise<"ok" | "unavailable" | "not_configured"> {
  const redis = getSharedRedis();
  if (!redis) return "not_configured";
  try {
    const res = await Promise.race([redis.ping(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return res === "PONG" ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function closeSharedRedis(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => shared?.disconnect());
    shared = undefined;
  }
}
