import { describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { dispatchOperation, enqueueOperation, findDueOperations, PermanentError, RetryableError, runOperation } from "@/server/jobs/operations";

describe("durable background operations", () => {
  it("deduplicates enqueue by dedupe key", async () => {
    const a = await enqueueOperation({ type: "test.op", payload: { n: 1 }, dedupeKey: "invoice:sub-1:2026-10" });
    const b = await enqueueOperation({ type: "test.op", payload: { n: 2 }, dedupeKey: "invoice:sub-1:2026-10" });
    expect(b.id).toBe(a.id);
    expect(await db.backgroundOperation.count()).toBe(1);
  });

  it("enqueues inside a caller transaction and rolls back with it", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await enqueueOperation({ type: "test.op", payload: {} }, tx);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.backgroundOperation.count()).toBe(0);
  });

  it("dispatch without Redis leaves the row pending for the sweeper", async () => {
    const op = await enqueueOperation({ type: "test.op", payload: {} });
    expect(await dispatchOperation(op)).toBe(false);
    expect((await findDueOperations()).map((o) => o.id)).toContain(op.id);
  });

  it("runs a handler once even when claimed concurrently", async () => {
    const op = await enqueueOperation({ type: "test.op", payload: {} });
    const handler = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const results = await Promise.all([runOperation(op.id, { "test.op": handler }), runOperation(op.id, { "test.op": handler })]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await db.backgroundOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("SUCCEEDED");
    // A finished operation is never re-run.
    expect(await runOperation(op.id, { "test.op": handler })).toBeNull();
  });

  it("retries transient failures with backoff and dead-letters after max attempts", async () => {
    const op = await enqueueOperation({ type: "test.flaky", payload: {}, maxAttempts: 2 });
    const handler = vi.fn(async () => {
      throw new RetryableError("router timeout", "TIMEOUT");
    });
    const first = await runOperation(op.id, { "test.flaky": handler });
    expect(first?.status).toBe("FAILED");
    expect(first?.lastError).toBe("TIMEOUT: router timeout");
    expect(first!.runAfter.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: a second run is refused.
    expect(await runOperation(op.id, { "test.flaky": handler })).toBeNull();
    await db.backgroundOperation.update({ where: { id: op.id }, data: { runAfter: new Date(Date.now() - 1000) } });
    const second = await runOperation(op.id, { "test.flaky": handler });
    expect(second?.status).toBe("DEAD");
    expect(second?.attempts).toBe(2);
  });

  it("does not retry permanent failures and hides unexpected error details", async () => {
    const p = await enqueueOperation({ type: "test.perm", payload: {} });
    expect((await runOperation(p.id, { "test.perm": async () => { throw new PermanentError("invalid target", "INVALID_TARGET"); } }))?.status).toBe("DEAD");

    const u = await enqueueOperation({ type: "test.unexpected", payload: {} });
    const res = await runOperation(u.id, { "test.unexpected": async () => { throw new Error("password=secret123 leaked"); } });
    expect(res?.status).toBe("FAILED");
    expect(res?.lastError).toBe("UNEXPECTED: Error");
  });

  it("recovers operations left RUNNING by a crashed worker", async () => {
    const op = await enqueueOperation({ type: "test.op", payload: {} });
    await db.backgroundOperation.update({ where: { id: op.id }, data: { status: "RUNNING", startedAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await findDueOperations()).map((o) => o.id)).toContain(op.id);
    expect((await runOperation(op.id, { "test.op": async () => undefined }))?.status).toBe("SUCCEEDED");
  });
});
