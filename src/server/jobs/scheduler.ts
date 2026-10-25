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
}

export const RECURRING_JOBS: RecurringJob[] = [{ type: "subscriptions.expire_due", everyMinutes: 60 }];

export function bucketKey(now: Date, everyMinutes: number): string {
  const ms = everyMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString();
}

export async function scheduleRecurringJobs(now = new Date()): Promise<number> {
  const orgs = await db.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  let created = 0;
  for (const job of RECURRING_JOBS) {
    const bucket = bucketKey(now, job.everyMinutes);
    for (const org of orgs) {
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
