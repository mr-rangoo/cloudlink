import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { createRouter } from "@/server/services/routers";
import { manualPaymentInput, recordManualPayment } from "@/server/services/payments";
import { dashboardPulse, navigationCounts } from "@/server/services/dashboard";
import { searchQuery, searchRecords } from "@/server/services/search";
import { addLocalDays, localDateKey, startOfLocalDay } from "@/server/domain/time";
import { contextFor, createOrg, createStaff } from "./fixtures";

let phoneSeq = 0;
const nextPhone = () => `07${String(41_000_000 + phoneSeq++).padStart(8, "0")}`;
const TZ = "Africa/Nairobi";

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, { name: "Fibre 10", serviceType: "PPPOE", price: "2500.00", taxRate: "0", billingUnit: "MONTH", billingCount: 1, description: null });
  const make = async (firstName: string) => (await createSubscriber(ctx, subscriberInput.parse({ firstName, phone: nextPhone(), packageId: pkg.id, activateSubscription: true }))) as { subscriber: { id: string }; subscription: { id: string } };
  return { org, ctx, a: await make("Amina"), b: await make("Brian"), c: await make("Chao") };
}

describe("overview pulse", () => {
  it("compares today with yesterday, lists what expires next and counts who is online", async () => {
    const { org, ctx, a, b, c } = await setup();
    const now = new Date();
    const today = startOfLocalDay(now, TZ);
    const yesterday = addLocalDays(today, -1, TZ);
    const byNow = new Date(yesterday.getTime() + (now.getTime() - today.getTime()));
    const pay = (subscriberId: string, amount: string, receivedAt: Date) => recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId, amount, method: "CASH", receivedAt: receivedAt.toISOString() }));
    await pay(a.subscriber.id, "1500", new Date(now.getTime() - 1000));
    const early = new Date(yesterday.getTime() + 60_000); // yesterday, one minute after midnight
    await pay(b.subscriber.id, "1000", early);
    const late = new Date(today.getTime() - 60_000); // yesterday, one minute before midnight
    await pay(c.subscriber.id, "400", late);

    // a expires in two hours; c expired two days ago; a and b have network access and only a is connected.
    await db.subscription.update({ where: { id: a.subscription.id }, data: { currentPeriodEnd: new Date(now.getTime() + 2 * 3_600_000), networkUsername: "amina" } });
    await db.subscription.update({ where: { id: b.subscription.id }, data: { networkUsername: "brian" } });
    await db.subscription.update({ where: { id: c.subscription.id }, data: { status: "EXPIRED", currentPeriodStart: new Date(now.getTime() - 32 * 86_400_000), currentPeriodEnd: new Date(now.getTime() - 2 * 86_400_000) } });
    const router = await createRouter(ctx, { name: "Core-1", host: "10.0.0.1", username: "api", password: "secret-pass" });
    await db.networkSession.create({ data: { organizationId: org.organization.id, routerId: router.id, kind: "PPPOE", username: "amina", externalId: "*1", source: "mock", lastSeenAt: now, startedAt: now } });

    const p = await dashboardPulse(ctx);
    const expectYesterdayByNow = (early < byNow ? 1000 : 0) + (late < byNow ? 400 : 0);
    expect(p.collections).toMatchObject({ currency: "KES", today: "1500.00", todayPayments: 1, yesterday: "1400.00", yesterdayByNow: expectYesterdayByNow.toFixed(2) });
    expect(p.collections!.days).toHaveLength(14);
    expect(p.collections!.days.at(-1)).toMatchObject({ day: localDateKey(now, TZ), amount: "1500.00", payments: 1 });
    expect(p.recentPayments![0]).toMatchObject({ amount: "1500.00", subscriber: { id: a.subscriber.id } });
    expect(p.expiring).toMatchObject({ count: 1, rows: [expect.objectContaining({ id: a.subscription.id })] });
    expect(p.subscriberHealth).toEqual({ provisioned: 2, online: 1, expired7d: 1 });
    expect(p.busiestRouters).toEqual([expect.objectContaining({ id: router.id, sessions: 1, health: expect.objectContaining({ score: null }) })]);
    expect(p.renewalsDue).not.toBeNull();
  });

  it("respects branch scope and permissions", async () => {
    const { org, ctx, a } = await setup();
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: a.subscriber.id, amount: "900", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    const branch = await db.branch.create({ data: { organizationId: org.organization.id, name: "Ruiru", code: "RUI" } });
    const cashier = await createStaff(org.organization.id, "cashier", { branchIds: [branch.id] });
    const scoped = await dashboardPulse(await contextFor(cashier.user.id, org.organization.id));
    expect(scoped.collections).toMatchObject({ today: "0.00", todayPayments: 0 });
    expect(scoped.recentPayments).toEqual([]);

    const sales = await createStaff(org.organization.id, "sales");
    const s = await dashboardPulse(await contextFor(sales.user.id, org.organization.id));
    expect(s.collections).toBeNull();
    expect(s.recentPayments).toBeNull();
    expect(s.busiestRouters).toBeNull();
    const tech = await createStaff(org.organization.id, "technician");
    const t = await dashboardPulse(await contextFor(tech.user.id, org.organization.id));
    expect(t.collections).toBeNull();
    expect(t.busiestRouters).toEqual([]);
    expect(t.subscriberHealth).toEqual({ provisioned: 0, online: 0, expired7d: 0 });
  });
});

describe("record search and sidebar counts", () => {
  it("finds records by name, account, phone, receipt and M-Pesa code within permission and scope", async () => {
    const { org, ctx, a } = await setup();
    const sub = await db.subscriber.findUniqueOrThrow({ where: { id: a.subscriber.id } });
    const { payment } = await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: sub.id, amount: "700", method: "MPESA", reference: "QWE7XY12AB", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    const router = await createRouter(ctx, { name: "Westlands-Core", host: "10.9.0.1", username: "api", password: "secret-pass" });
    const search = (c: typeof ctx, q: string) => searchRecords(c, searchQuery.parse({ q }));

    expect((await search(ctx, "amina")).map((h) => h.id)).toContain(sub.id);
    expect((await search(ctx, sub.accountNumber)).find((h) => h.type === "subscriber")).toMatchObject({ id: sub.id, href: `/subscribers/${sub.id}` });
    expect((await search(ctx, sub.phone.slice(-6))).map((h) => h.id)).toContain(sub.id);
    expect((await search(ctx, "qwe7xy")).find((h) => h.type === "payment")).toMatchObject({ id: payment.id, href: `/payments/${payment.id}` });
    expect((await search(ctx, payment.receiptNumber!)).map((h) => h.id)).toContain(payment.id);
    expect((await search(ctx, "westlands")).find((h) => h.type === "router")).toMatchObject({ id: router.id });
    expect(() => searchQuery.parse({ q: "a" })).toThrow();

    // Sales staff cannot read payments or routers; other organizations and other branches see nothing.
    const sales = await createStaff(org.organization.id, "sales");
    const salesHits = await search(await contextFor(sales.user.id, org.organization.id), "qwe7xy");
    expect(salesHits.filter((h) => h.type === "payment")).toEqual([]);
    expect((await search(await contextFor(sales.user.id, org.organization.id), "westlands")).filter((h) => h.type === "router")).toEqual([]);
    const branch = await db.branch.create({ data: { organizationId: org.organization.id, name: "Thika", code: "THK" } });
    const scoped = await createStaff(org.organization.id, "cashier", { branchIds: [branch.id] });
    expect(await search(await contextFor(scoped.user.id, org.organization.id), "amina")).toEqual([]);
    const other = await createOrg("Other ISP");
    expect(await search(await contextFor(other.owner.id, other.organization.id), "amina")).toEqual([]);
  });

  it("counts online sessions, offline routers and payments to match for the sidebar", async () => {
    const { org, ctx } = await setup();
    const router = await createRouter(ctx, { name: "Edge-1", host: "10.9.0.2", username: "api", password: "secret-pass" });
    await db.router.update({ where: { id: router.id }, data: { status: "OFFLINE" } });
    await db.networkSession.create({ data: { organizationId: org.organization.id, routerId: router.id, kind: "PPPOE", username: "x1", externalId: "*9", source: "mock", lastSeenAt: new Date() } });
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: null, amount: "300", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    expect(await navigationCounts(ctx)).toMatchObject({ sessions: 1, routersOffline: 1, reconciliation: 1, support: 0 });
    const sales = await createStaff(org.organization.id, "sales");
    expect(await navigationCounts(await contextFor(sales.user.id, org.organization.id))).toEqual({ sessions: null, routersOffline: null, support: null, reconciliation: null });
  });
});
