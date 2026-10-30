import "server-only";
import { db } from "@/server/db/client";
import { dispatchOperation, enqueueOperation } from "@/server/jobs/operations";

/**
 * Recurring jobs. Each run is a durable BackgroundOperation whose dedupeKey contains the time bucket,
 * so any number of workers (or restarts) schedule a given bucket exactly once.
 */
export interface RecurringJob {
  type: string;
  /** Bucket granularity in minutes. */
  everyMinutes: number;
  /** "routers": only organizations that have at least one active router. */
  scope?: "all" | "routers";
}

export const RECURRING_JOBS: RecurringJob[] = [
  { type: "billing.run_recurring", everyMinutes: 60 },
  // Every minute: hotspot plans last minutes or hours and must end on time.
  { type: "subscriptions.expire_due", everyMinutes: 1 },
  { type: "subscriptions.remind_expiring", everyMinutes: 60 },
  // Hourly; sends only at each organization's chosen local hour.
  { type: "operators.daily_digest", everyMinutes: 60 },
  // Every five minutes: each check also stores a telemetry sample (charts, health score, reachability).
  { type: "routers.healthcheck", everyMinutes: 5, scope: "routers" },
  { type: "network.sync_sessions", everyMinutes: 5, scope: "routers" },
  { type: "network.monitor", everyMinutes: 15, scope: "routers" },
  { type: "plans.enforce_schedules", everyMinutes: 1, scope: "routers" },
  { type: "maintenance.prune", everyMinutes: 24 * 60 },
];

/** Routine operations that leave nothing worth keeping once they succeed. Failures are always kept. */
const ROUTINE_TYPES = ["network.sync_sessions", "routers.healthcheck", "network.monitor", "maintenance.prune", "subscriptions.expire_due", "subscriptions.remind_expiring", "operators.daily_digest", "plans.enforce_schedules"];
export const ROUTINE_RETENTION_DAYS = 14;

/** Delete succeeded routine operations older than the retention window (live session views create one every 30 s). */
export async function pruneRoutineOperations(organizationId: string, now = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - ROUTINE_RETENTION_DAYS * 86_400_000);
  const { count } = await db.backgroundOperation.deleteMany({ where: { organizationId, type: { in: ROUTINE_TYPES }, status: "SUCCEEDED", finishedAt: { lt: cutoff } } });
  return { deleted: count };
}

export function bucketKey(now: Date, everyMinutes: number): string {
  const ms = everyMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString();
}

export async function scheduleRecurringJobs(now = new Date()): Promise<number> {
  const orgs = await db.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const withRouters = new Set(
    (await db.router.groupBy({ by: ["organizationId"], where: { archivedAt: null, organizationId: { in: orgs.map((o) => o.id) } } })).map((r) => r.organizationId),
  );
  let created = 0;
  for (const job of RECURRING_JOBS) {
    const bucket = bucketKey(now, job.everyMinutes);
    for (const org of orgs) {
      if (job.scope === "routers" && !withRouters.has(org.id)) continue;
      const dedupeKey = `${job.type}:${org.id}:${bucket}`;
      const op = await enqueueOperation({ type: job.type, organizationId: org.id, payload: { bucket }, dedupeKey, maxAttempts: 3 });
      if (op.status === "PENDING") {
        created++;
        await dispatchOperation(op); // BullMQ jobId = operation id, so repeated dispatch is harmless
      }
    }
  }
  return created;
}
