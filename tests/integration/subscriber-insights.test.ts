import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, listSubscribers, subscriberInput, subscriberListQuery, subscriberStats, subscriberUpdate, updateSubscriber } from "@/server/services/subscribers";
import { applySubscriptionAction, compensateSubscription } from "@/server/services/subscriptions";
import { runRecurringBilling } from "@/server/services/invoices";
import { createRouter } from "@/server/services/routers";
import { periodAt } from "@/server/domain/billing-period";
import { POST as compensateRoute } from "@/app/api/v1/subscriptions/[id]/compensate/route";
import { contextFor, createOrg, createStaff, request, sessionFor } from "./fixtures";

let phoneSeq = 0;
const nextPhone = () => `07${String(52_000_000 + phoneSeq++).padStart(8, "0")}`;
const TZ = "Africa/Nairobi";
const DAY = 86_400_000;

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const fibre = await createPackage(ctx, packageInput.parse({ name: "Fibre 10", serviceType: "PPPOE", price: "2500.00", billingUnit: "MONTH", billingCount: 1, downloadKbps: 10000, uploadKbps: 5000 }));
  const daily = await createPackage(ctx, packageInput.parse({ name: "Daily 5", serviceType: "HOTSPOT", price: "50.00", billingUnit: "DAY", billingCount: 1, downloadKbps: 5000, uploadKbps: 5000 }));
  const make = async (firstName: string, packageId?: string) =>
    (await createSubscriber(ctx, subscriberInput.parse({ firstName, phone: nextPhone(), ...(packageId ? { packageId, activateSubscription: true } : {}) }))) as { subscriber: { id: string }; subscription: { id: string } | null };
  return { org, ctx, fibre, daily, make };
}

const q = (o: Record<string, string> = {}) => subscriberListQuery.parse(o);

describe("subscriber list filters and stats", () => {
  it("filters by connection, service, router, VIP and risk, and shows router and last online", async () => {
    const { org, ctx, fibre, daily, make } = await setup();
    const a = await make("Amina", fibre.id);
    const b = await make("Brian", daily.id);
    const c = await make("Chao");
    const r1 = await createRouter(ctx, { name: "Core-1", host: "10.0.0.1", username: "api", password: "secret-pass" });
    const r2 = await createRouter(ctx, { name: "Hotspot-2", host: "10.0.0.2", username: "api", password: "secret-pass", hotspotEnabled: true });
    await db.subscription.update({ where: { id: a.subscription!.id }, data: { networkRouterId: r1.id, networkUsername: "amina" } });
    await db.subscription.update({ where: { id: b.subscription!.id }, data: { networkRouterId: r2.id, networkUsername: "brian", currentPeriodEnd: new Date(Date.now() + DAY / 2) } });
    const orgId = org.organization.id;
    await db.networkSession.create({ data: { organizationId: orgId, routerId: r1.id, subscriberId: a.subscriber.id, kind: "PPPOE", username: "amina", externalId: "*1", source: "mock", lastSeenAt: new Date() } });
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await db.networkSession.create({ data: { organizationId: orgId, routerId: r2.id, subscriberId: b.subscriber.id, kind: "HOTSPOT", username: "brian", externalId: "*2", source: "mock", lastSeenAt: twoHoursAgo, endedAt: twoHoursAgo } });
    await updateSubscriber(ctx, c.subscriber.id, subscriberUpdate.parse({ vip: true }));

    const ids = async (o: Record<string, string>) => (await listSubscribers(ctx, q(o))).rows.map((r) => r.id).sort();
    expect(await ids({ connection: "online" })).toEqual([a.subscriber.id]);
    expect(await ids({ connection: "offline" })).toEqual([b.subscriber.id]);
    expect(await ids({ service: "HOTSPOT" })).toEqual([b.subscriber.id]);
    expect(await ids({ routerId: r1.id })).toEqual([a.subscriber.id]);
    expect(await ids({ vip: "1" })).toEqual([c.subscriber.id]);
    expect(await ids({ risk: "1" })).toEqual([b.subscriber.id]);
    expect(await ids({ created: "7d", connection: "online" })).toEqual([a.subscriber.id]);

    const rows = (await listSubscribers(ctx, q())).rows;
    expect(rows.find((r) => r.id === a.subscriber.id)).toMatchObject({ online: true, router: { name: "Core-1" } });
    expect(rows.find((r) => r.id === b.subscriber.id)).toMatchObject({ online: false, lastSeenAt: twoHoursAgo, router: { name: "Hotspot-2" } });
    expect(rows.find((r) => r.id === c.subscriber.id)).toMatchObject({ vip: true, online: false, lastSeenAt: null, router: null });
    expect(await subscriberStats(ctx)).toEqual({ total: 3, active: 2, online: 1, offline: 1, atRisk: 1, vip: 1, newLast30Days: 3 });

    // Other organizations see nothing of this.
    const other = await createOrg("Other ISP");
    const otherCtx = await contextFor(other.owner.id, other.organization.id);
    expect((await listSubscribers(otherCtx, q({ connection: "online" }))).total).toBe(0);
    expect((await subscriberStats(otherCtx)).online).toBe(0);
  });
});

describe("compensation", () => {
  it("extends the period and later periods continue from the new end", async () => {
    const { ctx, fibre, make } = await setup();
    const { subscription } = await make("Dorcas", fibre.id);
    const before = await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } });
    const end = before.currentPeriodEnd!;
    const after = await compensateSubscription(ctx, before.id, { amount: 2, unit: "DAY", reason: "Fibre cut in Ruaka" });
    expect(after.currentPeriodEnd!.getTime()).toBe(end.getTime() + 2 * DAY);
    expect(after).toMatchObject({ periodIndex: -1, status: "ACTIVE" });
    expect(after.billingAnchorAt).toEqual(after.currentPeriodEnd);

    // The next recurring invoice covers the period starting exactly at the new end.
    const r = await runRecurringBilling(ctx, new Date(after.currentPeriodEnd!.getTime() - DAY));
    expect(r.created).toBe(1);
    const next = periodAt(after.currentPeriodEnd!, "MONTH", 1, 0, TZ);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: before.id } })).invoicedThrough).toEqual(next.end);

    // Renewal continues from the new end too.
    const renewed = await applySubscriptionAction(ctx, before.id, "renew", { idempotencyKey: "renew-after-comp", invoice: false });
    expect(renewed.currentPeriodStart).toEqual(after.currentPeriodEnd);
    expect(renewed.currentPeriodEnd).toEqual(next.end);
    expect(renewed.periodIndex).toBe(0);

    const events = await db.subscriptionEvent.findMany({ where: { subscriptionId: before.id, type: "compensated" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ amount: 2, unit: "DAY", reason: "Fibre cut in Ruaka" });
    expect(await db.subscriberActivity.count({ where: { type: "subscription.compensated" } })).toBeGreaterThan(0);
    expect(await db.auditLog.count({ where: { action: "subscription.compensate", entityId: before.id } })).toBe(1);
  });

  it("is idempotent through the API, refuses unsafe cases and needs permission", async () => {
    const { org, ctx, fibre, daily, make } = await setup();
    const { subscription } = await make("Esther", fibre.id);
    const id = subscription!.id;
    const end = (await db.subscription.findUniqueOrThrow({ where: { id } })).currentPeriodEnd!;
    const token = await sessionFor(org.owner.id, org.organization.id);
    const call = (key?: string, body: Record<string, unknown> = { amount: 6, unit: "HOUR", reason: "Power outage" }) =>
      compensateRoute(request(`/api/v1/subscriptions/${id}/compensate`, { method: "POST", token, body, headers: key ? { "idempotency-key": key } : {} }), { params: Promise.resolve({ id }) });
    expect((await call()).status).toBe(400); // no Idempotency-Key
    expect((await call("comp-key-0001")).status).toBe(200);
    expect((await call("comp-key-0001")).status).toBe(200); // replayed, not applied twice
    expect((await db.subscription.findUniqueOrThrow({ where: { id } })).currentPeriodEnd!.getTime()).toBe(end.getTime() + 6 * 3_600_000);
    expect((await call("comp-key-0002", { amount: 91, unit: "DAY", reason: "Too much" })).status).toBe(400);

    await db.package.update({ where: { id: daily.id }, data: { kind: "DATA", dataQuotaMb: 1024 } });
    const bundle = await make("Fatuma", daily.id);
    await expect(compensateSubscription(ctx, bundle.subscription!.id, { amount: 1, unit: "DAY", reason: "Outage" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await applySubscriptionAction(ctx, id, "cancel", {});
    await expect(compensateSubscription(ctx, id, { amount: 1, unit: "DAY", reason: "Outage" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const support = await createStaff(org.organization.id, "support");
    await expect(compensateSubscription(await contextFor(support.user.id, org.organization.id), id, { amount: 1, unit: "DAY", reason: "Outage" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await createOrg("Other ISP");
    await expect(compensateSubscription(await contextFor(other.owner.id, other.organization.id), id, { amount: 1, unit: "DAY", reason: "Outage" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pushes the longer period to the router for hotspot logins", async () => {
    const { ctx, daily, make } = await setup();
    const router = await createRouter(ctx, { name: "Hotspot-1", host: "10.0.0.3", username: "api", password: "secret-pass", hotspotEnabled: true });
    const { subscription } = await make("Gitau", daily.id);
    await db.subscription.update({ where: { id: subscription!.id }, data: { networkRouterId: router.id, networkUsername: "gitau", networkPasswordEnc: "x", networkStatus: "ACTIVE" } });
    await compensateSubscription(ctx, subscription!.id, { amount: 3, unit: "HOUR", reason: "Access point down" });
    const op = await db.networkOperation.findFirstOrThrow({ where: { subscriptionId: subscription!.id }, orderBy: { createdAt: "desc" } });
    expect(op).toMatchObject({ type: "hotspot.access.enable", routerId: router.id });
    expect(op.params).toMatchObject({ username: "gitau", reason: "New period" });
  });
});
