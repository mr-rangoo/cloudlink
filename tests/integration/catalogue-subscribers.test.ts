import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, listPackages, updatePackage } from "@/server/services/packages";
import { addSubscriberNote, createSubscriber, getSubscriber, listSubscriberActivity, listSubscribers, subscriberInput, subscriberUpdate, updateSubscriber } from "@/server/services/subscribers";
import { applySubscriptionAction, createSubscription, expireDueSubscriptions } from "@/server/services/subscriptions";
import { systemContext } from "@/server/auth/context";
import { contextFor, createOrg, createStaff } from "./fixtures";

const pkgInput = { name: "Home 10 Mbps", serviceType: "PPPOE" as const, price: "2500.00", taxRate: "16", billingUnit: "MONTH" as const, billingCount: 1 };
const sub = (overrides: Record<string, unknown> = {}) => subscriberInput.parse({ firstName: "Jane", lastName: "Wanjiku", phone: "0712345678", ...overrides });

async function ownerCtx() {
  const org = await createOrg();
  return { org, ctx: await contextFor(org.owner.id, org.organization.id) };
}

describe("packages", () => {
  it("creates packages in the organization currency and keeps subscription snapshots on price change", async () => {
    const { ctx } = await ownerCtx();
    const pkg = await createPackage(ctx, { ...pkgInput, description: null });
    expect(pkg.currency).toBe("KES");
    expect(pkg.price.toString()).toBe("2500");

    const { subscriber } = await createSubscriber(ctx, sub());
    const s = await createSubscription(ctx, { subscriberId: subscriber.id, packageId: pkg.id, activate: true, graceDays: 0, autoRenew: true });
    await updatePackage(ctx, pkg.id, { price: "3000.00" });

    const stored = await db.subscription.findUniqueOrThrow({ where: { id: s.id } });
    expect(stored.price.toString()).toBe("2500"); // snapshot unchanged
    expect(stored.taxRate.toString()).toBe("16");
    expect(await db.auditLog.count({ where: { action: "package.update", entityId: pkg.id } })).toBe(1);
  });

  it("refuses to archive a package with live subscriptions and isolates tenants", async () => {
    const { ctx } = await ownerCtx();
    const other = await ownerCtx();
    const pkg = await createPackage(ctx, { ...pkgInput, description: null });
    const { subscriber } = await createSubscriber(ctx, sub());
    await createSubscription(ctx, { subscriberId: subscriber.id, packageId: pkg.id, activate: true, graceDays: 0, autoRenew: true });
    await expect(updatePackage(ctx, pkg.id, { status: "ARCHIVED" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await listPackages(other.ctx, { status: "ALL" })).toEqual([]);
    await expect(updatePackage(other.ctx, pkg.id, { price: "1.00" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces unique package names per organization", async () => {
    const { ctx } = await ownerCtx();
    await createPackage(ctx, { ...pkgInput, description: null });
    await expect(createPackage(ctx, { ...pkgInput, description: null })).rejects.toMatchObject({ code: "CONFLICT", fields: [{ path: "name", message: "Already in use" }] });
  });
});

describe("subscribers", () => {
  it("assigns sequential account numbers per organization and normalises contacts", async () => {
    const { ctx } = await ownerCtx();
    const a = await createSubscriber(ctx, sub({ email: "Jane@Example.com" }));
    const b = await createSubscriber(ctx, sub({ firstName: "John", phone: "+254 722 000 111" }));
    expect(a.subscriber.accountNumber).toBe("A000001");
    expect(b.subscriber.accountNumber).toBe("A000002");
    expect(a.subscriber.phone).toBe("254712345678");
    const stored = await db.subscriber.findUniqueOrThrow({ where: { id: a.subscriber.id } });
    expect(stored.emailNormalized).toBe("jane@example.com");
  });

  it("rejects duplicate phone/email unless explicitly overridden (and audits the override)", async () => {
    const { ctx } = await ownerCtx();
    await createSubscriber(ctx, sub());
    await expect(createSubscriber(ctx, sub({ firstName: "Other" }))).rejects.toMatchObject({ code: "CONFLICT" });
    const dup = await createSubscriber(ctx, sub({ firstName: "Other", allowDuplicateContact: true }));
    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: dup.subscriber.id, action: "subscriber.create" } });
    expect((log.metadata as Record<string, unknown>).duplicateOverride).toBe(true);
  });

  it("creates subscriber and subscription atomically (rolls back on package error)", async () => {
    const { ctx } = await ownerCtx();
    const pkg = await createPackage(ctx, { ...pkgInput, description: null });
    await updatePackage(ctx, pkg.id, { status: "INACTIVE" });
    await expect(createSubscriber(ctx, sub({ packageId: pkg.id }))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.subscriber.count()).toBe(0);
  });

  it("validates input with field-level errors", () => {
    const bad = subscriberInput.safeParse({ type: "BUSINESS", phone: "12", email: "nope" });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["phone", "email"]));
    // Cross-field rules run once individual fields are valid.
    const noCompany = subscriberInput.safeParse({ type: "BUSINESS", phone: "0712345678" });
    expect(noCompany.error!.issues.map((i) => i.path.join("."))).toEqual(["companyName"]);
  });

  it("keeps an activity timeline including notes and updates", async () => {
    const { ctx } = await ownerCtx();
    const { subscriber } = await createSubscriber(ctx, sub());
    await addSubscriberNote(ctx, subscriber.id, "Prefers SMS reminders");
    await updateSubscriber(ctx, subscriber.id, subscriberUpdate.parse({ lastName: "Njeri" }));
    const activity = await listSubscriberActivity(ctx, subscriber.id);
    expect(activity.map((a) => a.type)).toEqual(["updated", "note", "created"]);
    const updated = await getSubscriber(ctx, subscriber.id);
    expect(updated.displayName).toBe("Jane Njeri");
    expect(updated.phone).toBe("254712345678"); // fields not sent in the PATCH are untouched
    expect(updated.firstName).toBe("Jane");
  });

  it("isolates organizations and restricts branch-scoped staff", async () => {
    const { org, ctx } = await ownerCtx();
    const other = await ownerCtx();
    const east = await db.branch.create({ data: { organizationId: org.organization.id, name: "East", code: "EAST" } });
    const mainSub = await createSubscriber(ctx, sub({ branchId: org.branch.id }));
    const eastSub = await createSubscriber(ctx, sub({ phone: "0733000000", branchId: east.id }));

    await expect(getSubscriber(other.ctx, mainSub.subscriber.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listSubscribers(other.ctx, { status: "ALL", page: 1, pageSize: 25, sort: "newest" })).total).toBe(0);

    const { user } = await createStaff(org.organization.id, "sales", { branchIds: [east.id] });
    const sales = await contextFor(user.id, org.organization.id);
    const visible = await listSubscribers(sales, { status: "ALL", page: 1, pageSize: 25, sort: "newest" });
    expect(visible.rows.map((r) => r.id)).toEqual([eastSub.subscriber.id]);
    await expect(getSubscriber(sales, mainSub.subscriber.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createSubscriber(sales, sub({ phone: "0744000000", branchId: org.branch.id }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const created = await createSubscriber(sales, sub({ phone: "0744000000", branchId: east.id }));
    expect(created.subscriber.branchId).toBe(east.id);
  });

  it("enforces role permissions server-side", async () => {
    const { org } = await ownerCtx();
    const { user } = await createStaff(org.organization.id, "support");
    const support = await contextFor(user.id, org.organization.id);
    await expect(createSubscriber(support, sub())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createPackage(support, { ...pkgInput, description: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("searches by name, account number and phone in any format", async () => {
    const { ctx } = await ownerCtx();
    await createSubscriber(ctx, sub());
    await createSubscriber(ctx, sub({ firstName: "Peter", lastName: "Otieno", phone: "0722111222" }));
    const q = (v: string) => listSubscribers(ctx, { q: v, status: "ALL", page: 1, pageSize: 25, sort: "newest" }).then((r) => r.rows.map((x) => x.displayName));
    expect(await q("otieno")).toEqual(["Peter Otieno"]);
    expect(await q("A000001")).toEqual(["Jane Wanjiku"]);
    expect(await q("0722 111 222")).toEqual(["Peter Otieno"]);
  });
});

describe("subscription lifecycle", () => {
  async function setup() {
    const { org, ctx } = await ownerCtx();
    const pkg = await createPackage(ctx, { ...pkgInput, description: null });
    const { subscriber } = await createSubscriber(ctx, sub());
    const s = await createSubscription(ctx, { subscriberId: subscriber.id, packageId: pkg.id, activate: true, graceDays: 2, autoRenew: true });
    return { org, ctx, pkg, subscriber, s };
  }

  it("activates with a timezone-aware monthly period", async () => {
    const { s } = await setup();
    expect(s.status).toBe("ACTIVE");
    expect(s.periodIndex).toBe(0);
    const days = (s.currentPeriodEnd!.getTime() - s.currentPeriodStart!.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
    expect(s.nextBillingAt?.getTime()).toBe(s.currentPeriodEnd?.getTime());
  });

  it("renews exactly once per idempotency key, even concurrently", async () => {
    const { ctx, s } = await setup();
    const results = await Promise.allSettled([
      applySubscriptionAction(ctx, s.id, "renew", { idempotencyKey: "payment:abc" }),
      applySubscriptionAction(ctx, s.id, "renew", { idempotencyKey: "payment:abc" }),
      applySubscriptionAction(ctx, s.id, "renew", { idempotencyKey: "payment:abc" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const after = await db.subscription.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.periodIndex).toBe(1);
    expect(after.currentPeriodStart?.getTime()).toBe(s.currentPeriodEnd?.getTime()); // continues seamlessly
    expect(await db.subscriptionEvent.count({ where: { subscriptionId: s.id, type: "renewed" } })).toBe(1);

    await applySubscriptionAction(ctx, s.id, "renew", { idempotencyKey: "payment:def" });
    expect((await db.subscription.findUniqueOrThrow({ where: { id: s.id } })).periodIndex).toBe(2);
  });

  it("suspends, reactivates, rejects invalid transitions and cancels terminally", async () => {
    const { ctx, s } = await setup();
    await expect(applySubscriptionAction(ctx, s.id, "reactivate")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await applySubscriptionAction(ctx, s.id, "suspend", { reason: "Non-payment" })).status).toBe("SUSPENDED");
    expect((await applySubscriptionAction(ctx, s.id, "reactivate")).status).toBe("ACTIVE");
    expect((await applySubscriptionAction(ctx, s.id, "cancel", { reason: "Relocating" })).status).toBe("CANCELLED");
    await expect(applySubscriptionAction(ctx, s.id, "renew", { idempotencyKey: "x-1" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const events = await db.subscriptionEvent.findMany({ where: { subscriptionId: s.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["created", "activated", "suspended", "reactivated", "cancelled"]);
  });

  it("refuses reactivation after the paid period ended; renewal restarts service from now", async () => {
    const { ctx, s } = await setup();
    await applySubscriptionAction(ctx, s.id, "suspend", { reason: "test" });
    await db.subscription.update({ where: { id: s.id }, data: { currentPeriodStart: new Date(Date.now() - 40 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 1000) } });
    await expect(applySubscriptionAction(ctx, s.id, "reactivate")).rejects.toMatchObject({ code: "INVALID_STATE" });
    const before = Date.now();
    const renewed = await applySubscriptionAction(ctx, s.id, "renew", { idempotencyKey: "late-pay" });
    expect(renewed.status).toBe("ACTIVE");
    expect(renewed.periodIndex).toBe(0);
    expect(renewed.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("expires subscriptions after period end plus grace days", async () => {
    const { org, ctx, s } = await setup();
    const sys = systemContext(org.organization.id, "worker:test", "test-corr");
    await db.subscription.update({ where: { id: s.id }, data: { currentPeriodStart: new Date(Date.now() - 40 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 1 * 86_400_000) } });
    expect(await expireDueSubscriptions(org.organization.id, sys)).toBe(0); // still within 2 grace days
    await db.subscription.update({ where: { id: s.id }, data: { currentPeriodStart: new Date(Date.now() - 40 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 3 * 86_400_000) } });
    expect(await expireDueSubscriptions(org.organization.id, sys)).toBe(1);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("EXPIRED");
    void ctx;
  });
});
