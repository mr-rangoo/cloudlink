import { afterAll, describe, expect, it } from "vitest";
import IORedis from "ioredis";
import { Worker } from "bullmq";

/**
 * Exercises the real BullMQ path (enqueue row → dispatch to Redis → worker → runOperation).
 * Runs only when TEST_REDIS_URL points at a reachable Redis; otherwise it is reported as skipped.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? "";

async function reachable(url: string): Promise<boolean> {
  if (!url) return false;
  const r = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1000, retryStrategy: () => null });
  r.on("error", () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const available = await reachable(redisUrl);
if (available) process.env.REDIS_URL = redisUrl;

const ops = await import("@/server/jobs/operations");
const { db } = await import("@/server/db/client");

describe.skipIf(!available)("BullMQ dispatch (requires TEST_REDIS_URL)", () => {
  const queueName = ops.OPERATIONS_QUEUE;
  let worker: Worker | undefined;

  afterAll(async () => {
    await worker?.close();
    await ops.closeQueue();
  });

  it("dispatches a durable operation through Redis and records the real outcome", async () => {
    const seen: string[] = [];
    worker = new Worker(
      queueName,
      async (job) => {
        await ops.runOperation((job.data as { operationId: string }).operationId, {
          "test.redis": async (op) => {
            seen.push(op.id);
          },
        });
      },
      { connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) },
    );

    const op = await ops.enqueueOperation({ type: "test.redis", payload: {}, dedupeKey: `redis-test-${Date.now()}` });
    expect(await ops.dispatchOperation(op)).toBe(true);
    // Dispatching the same row twice must not run it twice (jobId = operation id).
    await ops.dispatchOperation(op);

    const deadline = Date.now() + 10_000;
    let status = "";
    while (Date.now() < deadline) {
      status = (await db.backgroundOperation.findUniqueOrThrow({ where: { id: op.id } })).status;
      if (status === "SUCCEEDED") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("SUCCEEDED");
    expect(seen).toEqual([op.id]);
  });
});
