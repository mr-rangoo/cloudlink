import "server-only";
import { db } from "@/server/db/client";
import { pingRedis } from "@/server/jobs/redis";
import { parseEnv } from "@/server/env";

export type CheckStatus = "ok" | "unavailable" | "not_configured" | "invalid";

export async function checkDatabase(timeoutMs = 2000): Promise<CheckStatus> {
  try {
    await Promise.race([db.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return "ok";
  } catch {
    return "unavailable";
  }
}

export async function checkReadiness(): Promise<{ ready: boolean; checks: Record<string, CheckStatus> }> {
  let config: CheckStatus = "ok";
  try {
    parseEnv(process.env);
  } catch {
    config = "invalid";
  }
  const [database, redis] = await Promise.all([checkDatabase(), pingRedis()]);
  return { ready: database === "ok" && config === "ok", checks: { config, database, redis } };
}

/** Worker liveness as seen from the database heartbeat table (for authenticated status pages). */
export async function workerStatus(staleAfterMs = 60_000) {
  const beats = await db.workerHeartbeat.findMany({ orderBy: { seenAt: "desc" }, take: 10 });
  const now = Date.now();
  return beats.map((b) => ({ workerId: b.workerId, seenAt: b.seenAt, healthy: now - b.seenAt.getTime() < staleAfterMs }));
}
