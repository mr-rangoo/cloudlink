import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { bucketKey, scheduleRecurringJobs } from "@/server/jobs/scheduler";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { contextFor, createOrg } from "./fixtures";

describe("recurring job scheduler", () => {
  it("buckets time deterministically", () => {
    expect(bucketKey(new Date("2026-10-25T10:59:59Z"), 60)).toBe("2026-10-25T10:00:00.000Z");
    expect(bucketKey(new Date("2026-10-25T11:00:00Z"), 60)).toBe("2026-10-25T11:00:00.000Z");
  });

  it("schedules each organization once per bucket and the handler expires due subscriptions", async () => {
    const { owner, organization } = await createOrg();
    await createOrg("Second");
    const ctx = await contextFor(owner.id, organization.id);
    const pkg = await createPackage(ctx, { name: "Plan P", serviceType: "PPPOE", price: "100.00", taxRate: "0", billingUnit: "MONTH", billingCount: 1, description: null });
    const { subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Late", phone: "0711000111", packageId: pkg.id }));
    await db.subscription.update({ where: { id: subscription!.id }, data: { currentPeriodStart: new Date(Date.now() - 40 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 60_000) } });

    const now = new Date();
    await scheduleRecurringJobs(now);
    await scheduleRecurringJobs(now); // second worker / restart in the same bucket
    const ops = await db.backgroundOperation.findMany({ where: { type: "subscriptions.expire_due" } });
    expect(ops).toHaveLength(2); // one per organization

    for (const op of ops) await runOperation(op.id, operationHandlers);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } })).status).toBe("EXPIRED");
    expect(await db.subscriptionEvent.count({ where: { subscriptionId: subscription!.id, type: "expired", actorType: "worker:subscriptions" } })).toBe(1);
  });
});
