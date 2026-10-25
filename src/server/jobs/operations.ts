import "server-only";
import { Queue } from "bullmq";
import { db, type Tx } from "@/server/db/client";
import { createRedisConnection } from "@/server/jobs/redis";
import { logger } from "@/server/observability/logger";
import type { BackgroundOperation, Prisma } from "@/generated/prisma/client";

/**
 * Durable background operations.
 *
 * 1. `enqueueOperation` writes a BackgroundOperation row (optionally inside the caller's transaction).
 *    A `dedupeKey` makes enqueueing idempotent: the same key always maps to one row.
 * 2. `dispatchOperation` pushes the row id to BullMQ (jobId = row id, so BullMQ also dedupes).
 *    If Redis is down the row stays PENDING and the worker's database sweeper picks it up.
 * 3. `runOperation` atomically claims the row, runs the handler, and records the real outcome
 *    with bounded exponential-backoff retries. Handlers must be idempotent.
 */

export const OPERATIONS_QUEUE = "cloudlink-operations";
export const RUNNING_LEASE_MS = 10 * 60 * 1000;

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly code = "RETRYABLE",
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly code = "PERMANENT",
  ) {
    super(message);
    this.name = "PermanentError";
  }
}

export type OperationHandler = (op: BackgroundOperation) => Promise<Record<string, unknown> | void>;
export type OperationHandlers = Record<string, OperationHandler>;

export interface EnqueueInput {
  type: string;
  organizationId?: string | null;
  payload: Prisma.InputJsonValue;
  dedupeKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
  correlationId?: string;
}

export async function enqueueOperation(input: EnqueueInput, tx?: Tx): Promise<BackgroundOperation> {
  const client = tx ?? db;
  const data = {
    type: input.type,
    organizationId: input.organizationId ?? null,
    payload: input.payload,
    dedupeKey: input.dedupeKey ?? null,
    runAfter: input.runAfter ?? new Date(),
    maxAttempts: input.maxAttempts ?? 5,
    correlationId: input.correlationId ?? null,
  };
  if (!input.dedupeKey) return client.backgroundOperation.create({ data });
  // ON CONFLICT DO NOTHING semantics via upsert with empty update.
  return client.backgroundOperation.upsert({ where: { dedupeKey: input.dedupeKey }, update: {}, create: data });
}

let queue: Queue | null | undefined;
function getQueue(): Queue | null {
  if (queue === undefined) {
    const connection = createRedisConnection();
    if (!connection) {
      queue = null;
    } else {
      connection.on("error", () => undefined);
      queue = new Queue(OPERATIONS_QUEUE, { connection });
      queue.on("error", () => undefined);
    }
  }
  return queue;
}

/** Best-effort dispatch to BullMQ. Never throws; the database sweeper is the safety net. */
export async function dispatchOperation(op: Pick<BackgroundOperation, "id" | "runAfter" | "type">): Promise<boolean> {
  const q = getQueue();
  if (!q) return false;
  try {
    const delay = Math.max(0, op.runAfter.getTime() - Date.now());
    await Promise.race([
      q.add(op.type, { operationId: op.id }, { jobId: op.id, delay, removeOnComplete: 1000, removeOnFail: 5000, attempts: 1 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("dispatch timeout")), 2000)),
    ]);
    await db.backgroundOperation.updateMany({ where: { id: op.id, status: "PENDING" }, data: { status: "QUEUED" } });
    return true;
  } catch (err) {
    logger.warn({ operationId: op.id, err: (err as Error).message }, "operation dispatch failed; sweeper will retry");
    return false;
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof RetryableError || err instanceof PermanentError) return `${err.code}: ${err.message}`.slice(0, 500);
  if (err instanceof Error) return `UNEXPECTED: ${err.name}`.slice(0, 500);
  return "UNEXPECTED";
}

/** Claim and execute one operation. Safe to call concurrently: only one caller wins the claim. */
export async function runOperation(operationId: string, handlers: OperationHandlers): Promise<BackgroundOperation | null> {
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "BackgroundOperation"
    SET "status" = 'RUNNING', "attempts" = "attempts" + 1, "startedAt" = now(), "updatedAt" = now()
    WHERE "id" = ${operationId}::uuid
      AND "runAfter" <= now()
      AND ("status" IN ('PENDING', 'QUEUED', 'FAILED')
           OR ("status" = 'RUNNING' AND "startedAt" < now() - make_interval(secs => ${RUNNING_LEASE_MS / 1000})))
    RETURNING "id"`;
  if (claimed.length === 0) return null;

  const op = await db.backgroundOperation.findUniqueOrThrow({ where: { id: operationId } });
  const handler = handlers[op.type];
  const log = logger.child({ operationId: op.id, type: op.type, attempt: op.attempts, correlationId: op.correlationId });

  if (!handler) {
    log.error("no handler registered for operation type");
    return db.backgroundOperation.update({ where: { id: op.id }, data: { status: "DEAD", lastError: "NO_HANDLER", finishedAt: new Date() } });
  }

  try {
    await handler(op);
    log.info("operation succeeded");
    return db.backgroundOperation.update({ where: { id: op.id }, data: { status: "SUCCEEDED", lastError: null, finishedAt: new Date() } });
  } catch (err) {
    const permanent = err instanceof PermanentError;
    const exhausted = op.attempts >= op.maxAttempts;
    const status = permanent || exhausted ? "DEAD" : "FAILED";
    log.warn({ status, error: safeErrorMessage(err) }, "operation failed");
    return db.backgroundOperation.update({
      where: { id: op.id },
      data: {
        status,
        lastError: safeErrorMessage(err),
        runAfter: status === "FAILED" ? new Date(Date.now() + backoffMs(op.attempts)) : op.runAfter,
        finishedAt: status === "DEAD" ? new Date() : null,
      },
    });
  }
}

/** Find operations that are due (including stale RUNNING rows from crashed workers). */
export async function findDueOperations(limit = 50): Promise<Array<{ id: string }>> {
  return db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BackgroundOperation"
    WHERE "runAfter" <= now()
      AND ("status" IN ('PENDING', 'FAILED')
           OR ("status" = 'QUEUED' AND "updatedAt" < now() - interval '2 minutes')
           OR ("status" = 'RUNNING' AND "startedAt" < now() - make_interval(secs => ${RUNNING_LEASE_MS / 1000})))
    ORDER BY "runAfter" ASC
    LIMIT ${limit}`;
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close().catch(() => undefined);
    queue = undefined;
  }
}
