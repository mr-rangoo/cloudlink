/**
 * Cloudlink background worker. Run separately from the web process: `npm run worker`.
 *
 * - Consumes BullMQ jobs from Redis when REDIS_URL is reachable.
 * - Always runs a PostgreSQL sweeper so durable operations still progress if Redis is down
 *   or a dispatch was lost (e.g. web process crashed between commit and enqueue).
 * - Writes a heartbeat row for health monitoring and shuts down gracefully on SIGINT/SIGTERM.
 */
import "dotenv/config";
import os from "node:os";
import { Worker } from "bullmq";

process.env.CLOUDLINK_SERVICE ??= "cloudlink-worker";

async function main() {
  const { env } = await import("@/server/env");
  const { db, disconnectDb } = await import("@/server/db/client");
  const { logger } = await import("@/server/observability/logger");
  const { createRedisConnection } = await import("@/server/jobs/redis");
  const { OPERATIONS_QUEUE, runOperation, findDueOperations, closeQueue } = await import("@/server/jobs/operations");
  const { operationHandlers } = await import("@/server/jobs/handlers");

  env(); // fail fast on invalid configuration
  const workerId = `${os.hostname()}:${process.pid}`;
  const startedAt = new Date();
  let stopping = false;
  let bullWorker: Worker | null = null;

  const connection = createRedisConnection({ forWorker: true });
  if (connection) {
    connection.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));
    bullWorker = new Worker(
      OPERATIONS_QUEUE,
      async (job) => {
        const id = (job.data as { operationId?: string }).operationId;
        if (id) await runOperation(id, operationHandlers);
      },
      { connection, concurrency: 5 },
    );
    bullWorker.on("error", (err) => logger.warn({ err: err.message }, "bullmq worker error"));
    logger.info({ queue: OPERATIONS_QUEUE }, "bullmq worker started");
  } else {
    logger.warn("REDIS_URL not configured; running in database-polling mode only");
  }

  const heartbeat = async () => {
    await db.workerHeartbeat.upsert({
      where: { workerId },
      update: { seenAt: new Date() },
      create: { workerId, hostname: os.hostname(), startedAt, seenAt: new Date(), queues: [OPERATIONS_QUEUE] },
    });
  };

  const sweep = async () => {
    const due = await findDueOperations(50);
    for (const { id } of due) {
      if (stopping) break;
      await runOperation(id, operationHandlers);
    }
  };

  const loop = async () => {
    while (!stopping) {
      try {
        await heartbeat();
        await sweep();
      } catch (err) {
        logger.error({ err: (err as Error).message }, "worker sweep failed");
      }
      await new Promise((r) => setTimeout(r, Number(process.env.WORKER_SWEEP_INTERVAL_MS ?? 15_000)));
    }
  };

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker shutting down");
    const timer = setTimeout(() => process.exit(1), 20_000);
    await bullWorker?.close().catch(() => undefined);
    await closeQueue();
    await connection?.quit().catch(() => undefined);
    await db.workerHeartbeat.delete({ where: { workerId } }).catch(() => undefined);
    await disconnectDb();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info({ workerId }, "cloudlink worker started");
  await loop();
}

main().catch((err) => {
  console.error("worker failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
