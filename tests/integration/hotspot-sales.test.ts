import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { createPackage, updatePackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { applySubscriptionAction, expireDueSubscriptions } from "@/server/services/subscriptions";
import { createRouter } from "@/server/services/routers";
import { enforcePlanSchedules } from "@/server/services/network";
import { systemContext } from "@/server/auth/context";
import {
  hotspotAccessStatus,
  hotspotPurchaseStatus,
  portalPlans,
  reconnectHotspot,
  routerLoginPage,
  safeRouterLoginUrl,
  simulateHotspotPayment,
  startHotspotPurchase,
} from "@/server/services/hotspot-sales";
import { runOperation } from "@/server/jobs/operations";
import { listPayments } from "@/server/services/payments";
import { operationHandlers } from "@/server/jobs/handlers";
import { POST as purchaseRoute } from "@/app/api/v1/hotspot/[org]/purchase/route";
import { saveHotspotSettings } from "@/server/services/hotspot-settings";
import { FakeRouterOs } from "../support/fake-routeros";
import { contextFor, createOrg, createStaff, request } from "./fixtures";

const fake = new FakeRouterOs();
let seq = 0;
// The mock gateway rejects numbers ending in 000, so test numbers avoid that suffix.
const tel = () => `07${String(52_100_123 + 7 * seq++).padStart(8, "0")}`;
const meta = (ip = "10.30.0.1") => ({ correlationId: `hs-${randomUUID()}`, ipAddress: ip, userAgent: "vitest" });
const KEYS = ["NETWORK_ADAPTER", "PAYMENT_ADAPTER", "ROUTEROS_TIMEOUT_MS", "MIKROTIK_ALLOWED_NETWORKS", "MIKROTIK_CONNECTION_MODE", "APP_ENV", "MPESA_VERIFY_CALLBACKS"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.NETWORK_ADAPTER = "routeros";
  process.env.PAYMENT_ADAPTER = "mock";
  process.env.MPESA_VERIFY_CALLBACKS = "true";
  process.env.ROUTEROS_TIMEOUT_MS = "400";
  process.env.MIKROTIK_ALLOWED_NETWORKS = "";
  process.env.MIKROTIK_CONNECTION_MODE = "api";
  fake.reset();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function drain(organizationId: string) {
  for (let i = 0; i < 10; i++) {
    const due = await db.backgroundOperation.findMany({ where: { organizationId, status: { in: ["PENDING", "QUEUED"] }, runAfter: { lte: new Date() }, type: { not: "payments.mpesa.query" } }, orderBy: { createdAt: "asc" } });
    if (!due.length) return;
    for (const op of due) await runOperation(op.id, operationHandlers);
  }
}

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const router = await createRouter(ctx, { name: "Hs-1", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: true, pppoeEnabled: false, hotspotDnsName: "wifi.login" });
  const hour = await createPackage(ctx, { name: "Fast 1 hour", serviceType: "HOTSPOT", price: "10", billingUnit: "HOUR", billingCount: 1, uploadKbps: 5000, downloadKbps: 5000, deviceLimit: 1, highlight: "POPULAR" });
  await drain(org.organization.id); // profile push for the plan
  return { org, ctx, slug: org.organization.slug, router, hour };
}

/** Buy and pay a plan through the portal (mock M-Pesa), then run the worker. */
async function buy(slug: string, organizationId: string, input: { packageId: string; phone: string; routerId?: string | null; mac?: string | null; deviceMac?: string | null }) {
  const p = await startHotspotPurchase(slug, { ...input, requestId: randomUUID() }, meta());
  if (!("attemptId" in p)) throw new Error("expected a paid purchase");
  const s = await simulateHotspotPayment(slug, { attemptId: p.attemptId, token: p.token, outcome: "success" }, meta());
  await drain(organizationId);
  return { purchase: p, status: s };
}

describe("captive portal plans", () => {
  it("lists live hotspot plans with the customer price, respecting router restrictions", async () => {
    const { org, ctx, slug, router } = await setup();
    const other = await createRouter(ctx, { name: "Hs-2", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: true });
    await createPackage(ctx, { name: "Hidden", serviceType: "HOTSPOT", price: "20", availability: "HIDDEN" });
    await createPackage(ctx, { name: "Off", serviceType: "HOTSPOT", price: "20", availability: "OFF" });
    await createPackage(ctx, { name: "Home", serviceType: "PPPOE", price: "1500" });
    await createPackage(ctx, { name: "Taxed", serviceType: "HOTSPOT", price: "50", taxRate: "16" });
    await createPackage(ctx, { name: "Site 2 only", serviceType: "HOTSPOT", price: "30", routerIds: [other.id] });
    const a = await portalPlans(slug, router.id);
    expect(a.plans.map((p) => p.name).sort()).toEqual(["Fast 1 hour", "Taxed"]);
    expect(a.plans.find((p) => p.name === "Taxed")).toMatchObject({ price: "58.00", payable: true });
    expect(a.plans.find((p) => p.name === "Fast 1 hour")).toMatchObject({ price: "10.00", highlight: "POPULAR", availableNow: true });
    expect(a).toMatchObject({ routerId: router.id, routerLoginHost: "wifi.login", payments: { mpesa: true, testMode: true } });
    expect((await portalPlans(slug, other.id)).plans.map((p) => p.name)).toContain("Site 2 only");
    await expect(portalPlans("no-such-org")).rejects.toMatchObject({ code: "NOT_FOUND" });
    void org;
  });

  it("accepts router login URLs only on private addresses or the router's hotspot name", () => {
    expect(safeRouterLoginUrl("http://10.5.50.1/login", null)).toBe("http://10.5.50.1/login");
    expect(safeRouterLoginUrl("http://wifi.login/login?x=1", "wifi.login")).toBe("http://wifi.login/login");
    expect(safeRouterLoginUrl("http://wifi.login/login", null)).toBeNull();
    expect(safeRouterLoginUrl("https://evil.example/login", "wifi.login")).toBeNull();
    expect(safeRouterLoginUrl("http://8.8.8.8/login", null)).toBeNull();
    expect(safeRouterLoginUrl("http://10.5.50.1/other", null)).toBeNull();
    expect(safeRouterLoginUrl("javascript:alert(1)", null)).toBeNull();
    expect(safeRouterLoginUrl("http://user:pw@10.5.50.1/login", null)).toBeNull();
  });

  it("uses the organization's portal settings (template, headline, steps, contacts, tabs)", async () => {
    const { ctx, slug } = await setup();
    expect((await portalPlans(slug)).display).toMatchObject({ template: "harbor", steps: null, showVouchers: true, showReconnect: true });
    await expect(saveHotspotSettings(ctx, { template: "no-such-template" })).rejects.toThrow();
    await expect(saveHotspotSettings(ctx, { template: "guided", supportPhone: "12" })).rejects.toThrow();
    await saveHotspotSettings(ctx, { template: "guided", headline: "Karibu!", instructions: "Pick a plan\n\n  Pay with M-Pesa  \nDone", supportPhone: "0712 345 678", whatsappPhone: "+254 712 000 111", showVouchers: false, showReconnect: true });
    const p = await portalPlans(slug);
    expect(p.display).toEqual({ template: "guided", steps: ["Pick a plan", "Pay with M-Pesa", "Done"], showVouchers: false, showReconnect: true });
    expect(p.support).toMatchObject({ phone: "0712 345 678", whatsapp: "254712000111", welcome: "Karibu!" });
    const { user } = await createStaff(ctx.organizationId, "cashier");
    await expect(saveHotspotSettings(await contextFor(user.id, ctx.organizationId), { template: "plain" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("serves a router login page that forwards MikroTik variables to the portal", async () => {
    const { slug, router, ctx } = await setup();
    const html = (await routerLoginPage(router.id))!;
    expect(html).toContain(`/hotspot/${slug}?router=${router.id}`);
    expect(html).toContain("$(mac-esc)");
    expect(html).toContain("$(link-login-only-esc)");
    const ppp = await createRouter(ctx, { name: "Ppp-only", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: false });
    expect(await routerLoginPage(ppp.id)).toBeNull();
  });
});

describe("hotspot purchase", () => {
  it("creates the customer, activates the plan on a verified payment, pays its invoice and enables the router login", async () => {
    const { org, slug, router, hour } = await setup();
    const phone = tel();
    const p = await startHotspotPurchase(slug, { packageId: hour.id, phone, mac: "aa-bb-cc-00-00-09", routerId: router.id, requestId: randomUUID() }, meta());
    if (!("attemptId" in p)) throw new Error("paid plan expected");
    expect(p).toMatchObject({ status: "SUBMITTED", amount: "10", testMode: true });
    const subscriber = await db.subscriber.findFirstOrThrow({ where: { organizationId: org.organization.id, phone: `254${phone.slice(1)}` } });
    expect(subscriber).toMatchObject({ source: "hotspot", type: "INDIVIDUAL" });

    // Before payment: no grant, and the router has not been touched.
    expect((await hotspotPurchaseStatus(slug, { attemptId: p.attemptId, token: p.token }, "10.30.0.1")).grant).toBeNull();
    expect(fake.tables["/ip/hotspot/user"]).toEqual([]);

    const before = Date.now();
    const s = await simulateHotspotPayment(slug, { attemptId: p.attemptId, token: p.token, outcome: "success" }, meta());
    expect(s.status).toBe("CONFIRMED");
    expect(s.grant).toMatchObject({ username: subscriber.accountNumber.toLowerCase(), ready: false });
    const sub = await db.subscription.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
    expect(sub).toMatchObject({ status: "ACTIVE", serviceType: "HOTSPOT", autoRenew: false, networkRouterId: router.id, networkMac: "AA:BB:CC:00:00:09", networkStatus: "PENDING" });
    expect(sub.currentPeriodEnd!.getTime() - sub.currentPeriodStart!.getTime()).toBe(3_600_000);
    expect(sub.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const invoice = await db.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(invoice).toMatchObject({ status: "PAID" });
    expect(invoice.total.toString()).toBe("10");
    const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { id: p.attemptId } });
    expect(attempt).toMatchObject({ subscriptionId: sub.id, activatedAt: null });
    expect(await db.notification.count({ where: { subscriberId: subscriber.id, templateKey: "invoice.issued" } })).toBe(0);

    await drain(org.organization.id);
    const user = fake.tables["/ip/hotspot/user"]!.find((u) => u.name === sub.networkUsername);
    expect(user).toMatchObject({ profile: "cl-fast-1-hour", disabled: "no", "limit-bytes-total": "0" });
    expect(user!["limit-uptime"]).toMatch(/^(59m\d+s|1h)$/);
    expect(await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ networkStatus: "ACTIVE" });
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: p.attemptId } })).activatedAt).not.toBeNull();
    // The payments list shows it as a hotspot purchase with its activation time.
    const listed = (await listPayments(await contextFor(org.owner.id, org.organization.id), { type: "hotspot" })).rows;
    expect(listed).toEqual([expect.objectContaining({ source: "hotspot", reconciliation: "allocated", activation: expect.objectContaining({ seconds: expect.any(Number) }) })]);

    const grant = (await hotspotPurchaseStatus(slug, { attemptId: p.attemptId, token: p.token }, "10.30.0.1")).grant!;
    expect(grant).toMatchObject({ ready: true, simulated: false });
    expect(user!.password).toBe(grant.password);
    expect(await hotspotAccessStatus(slug, { subscriptionId: sub.id, username: grant.username, password: grant.password }, "10.30.0.1")).toMatchObject({ ready: true });
    await expect(hotspotAccessStatus(slug, { subscriptionId: sub.id, username: grant.username, password: "wrong-pass" }, "10.30.0.1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(hotspotPurchaseStatus(slug, { attemptId: p.attemptId, token: "x".repeat(43) }, "10.30.0.1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stacks a repeat purchase, restarts on a plan switch, and never pays an older unpaid invoice", async () => {
    const { org, ctx, slug, router, hour } = await setup();
    const three = await createPackage(ctx, { name: "3 hours", serviceType: "HOTSPOT", price: "20", billingUnit: "HOUR", billingCount: 3, uploadKbps: 5000, downloadKbps: 5000 });
    const home = await createPackage(ctx, { name: "Home", serviceType: "PPPOE", price: "1500" });
    const phone = tel();
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Akinyi", phone, packageId: home.id, activateSubscription: true }));
    const ppp = await db.invoice.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
    expect(ppp.status).toBe("OPEN");

    await buy(slug, org.organization.id, { packageId: hour.id, phone, routerId: router.id });
    const first = await db.subscription.findFirstOrThrow({ where: { subscriberId: subscriber.id, serviceType: "HOTSPOT" } });
    expect((await db.invoice.findUniqueOrThrow({ where: { id: ppp.id } })).status).toBe("OPEN"); // the purchase paid only its own invoice

    await buy(slug, org.organization.id, { packageId: hour.id, phone, routerId: router.id });
    const stacked = await db.subscription.findUniqueOrThrow({ where: { id: first.id } });
    expect(stacked.currentPeriodEnd!.getTime()).toBe(first.currentPeriodEnd!.getTime() + 3_600_000);
    expect(await db.networkOperation.count({ where: { subscriptionId: first.id, type: "hotspot.access.enable" } })).toBe(2);

    const t0 = Date.now();
    await buy(slug, org.organization.id, { packageId: three.id, phone, routerId: router.id });
    const switched = await db.subscription.findUniqueOrThrow({ where: { id: first.id } });
    expect(switched).toMatchObject({ packageId: three.id, packageName: "3 hours" });
    expect(switched.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(switched.currentPeriodEnd!.getTime() - switched.currentPeriodStart!.getTime()).toBe(3 * 3_600_000);
    expect(await db.subscription.count({ where: { subscriberId: subscriber.id, serviceType: "HOTSPOT" } })).toBe(1);
    expect(fake.tables["/ip/hotspot/user"]!.find((u) => u.name === switched.networkUsername)!.profile).toBe("cl-3-hours");
  });

  it("expiry disables the login and logs the device out", async () => {
    const { org, slug, router, hour } = await setup();
    await buy(slug, org.organization.id, { packageId: hour.id, phone: tel(), routerId: router.id });
    const sub = await db.subscription.findFirstOrThrow({ where: { organizationId: org.organization.id, serviceType: "HOTSPOT" } });
    fake.addActiveHotspot(sub.networkUsername!);
    await db.subscription.update({ where: { id: sub.id }, data: { currentPeriodStart: new Date(Date.now() - 3_601_000), currentPeriodEnd: new Date(Date.now() - 1000) } });
    await db.paymentAttempt.updateMany({ where: { subscriptionId: sub.id }, data: { createdAt: new Date(Date.now() - 3_600_000) } });
    expect(await expireDueSubscriptions(org.organization.id, systemContext(org.organization.id, "test", "expire-1"))).toBe(1);
    await drain(org.organization.id);
    expect(fake.tables["/ip/hotspot/user"]!.find((u) => u.name === sub.networkUsername)).toMatchObject({ disabled: "yes" });
    expect(fake.tables["/ip/hotspot/active"]).toEqual([]);
    expect(fake.tables["/ip/hotspot/cookie"]).toEqual([]);
    expect(await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: "EXPIRED", networkStatus: "DISABLED" });
  });

  it("reconnects with the M-Pesa code and paying phone, moving the login to another hotspot", async () => {
    const { org, ctx, slug, router, hour } = await setup();
    const phone = tel();
    await buy(slug, org.organization.id, { packageId: hour.id, phone, routerId: router.id });
    const payment = await db.payment.findFirstOrThrow({ where: { organizationId: org.organization.id } });
    await expect(reconnectHotspot(slug, { phone, receipt: "WRONG12345" }, meta("10.30.0.7"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reconnectHotspot(slug, { phone: tel(), receipt: payment.providerTransactionId! }, meta("10.30.0.7"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const same = await reconnectHotspot(slug, { phone, receipt: payment.providerTransactionId!.toLowerCase() }, meta("10.30.0.7"));
    expect(same.grant).toMatchObject({ ready: true });

    const site2 = await createRouter(ctx, { name: "Hs-2", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: true });
    const moved = await reconnectHotspot(slug, { phone, receipt: payment.providerTransactionId!, routerId: site2.id }, meta("10.30.0.7"));
    expect(moved.grant.ready).toBe(false);
    const ops = await db.networkOperation.findMany({ where: { subscriptionId: moved.grant.subscriptionId, type: { in: ["hotspot.access.disable", "hotspot.access.enable"] } }, orderBy: { createdAt: "desc" }, take: 2 });
    expect(ops.map((o) => [o.type, o.routerId]).sort()).toEqual([["hotspot.access.disable", router.id], ["hotspot.access.enable", site2.id]].sort());
    await drain(org.organization.id);
    expect(await db.subscription.findUniqueOrThrow({ where: { id: moved.grant.subscriptionId } })).toMatchObject({ networkRouterId: site2.id, networkStatus: "ACTIVE" });
  });

  it("keeps the money as credit when the plan's price changed before the payment arrived", async () => {
    const { org, ctx, slug, router, hour } = await setup();
    const p = await startHotspotPurchase(slug, { packageId: hour.id, phone: tel(), routerId: router.id, requestId: randomUUID() }, meta());
    if (!("attemptId" in p)) throw new Error("paid plan expected");
    await updatePackage(ctx, hour.id, { price: "15" });
    const s = await simulateHotspotPayment(slug, { attemptId: p.attemptId, token: p.token, outcome: "success" }, meta());
    expect(s).toMatchObject({ status: "CONFIRMED", grant: null, detail: expect.stringContaining("kept as credit") });
    const payment = await db.payment.findFirstOrThrow({ where: { organizationId: org.organization.id } });
    expect(payment.allocatedAmount.toString()).toBe("0");
    expect(await db.subscription.count({ where: { organizationId: org.organization.id, serviceType: "HOTSPOT" } })).toBe(0);
  });

  it("is idempotent per request id and refuses closed schedules, other routers, suspended accounts and cents", async () => {
    const { org, ctx, slug, router, hour } = await setup();
    const phone = tel();
    const requestId = randomUUID();
    const a = await startHotspotPurchase(slug, { packageId: hour.id, phone, routerId: router.id, requestId }, meta());
    const b = await startHotspotPurchase(slug, { packageId: hour.id, phone, routerId: router.id, requestId }, meta());
    if (!("attemptId" in a)) throw new Error("paid plan expected");
    expect(b).toEqual(a);
    expect(await db.paymentAttempt.count({ where: { organizationId: org.organization.id } })).toBe(1);

    const nowLocal = new Date(Date.now() + 3 * 3_600_000);
    const start = ((nowLocal.getUTCHours() + 2) % 24) * 60;
    const night = await createPackage(ctx, { name: "Night", serviceType: "HOTSPOT", price: "30", billingUnit: "HOUR", billingCount: 8, scheduleEnabled: true, scheduleStartMinute: start, scheduleEndMinute: (start + 60) % 1440 });
    await expect(startHotspotPurchase(slug, { packageId: night.id, phone, routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "INVALID_STATE" });
    const site2 = await createRouter(ctx, { name: "Hs-2", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: true });
    const local = await createPackage(ctx, { name: "Site 2", serviceType: "HOTSPOT", price: "30", routerIds: [site2.id] });
    await expect(startHotspotPurchase(slug, { packageId: local.id, phone, routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "INVALID_STATE" });
    const cents = await createPackage(ctx, { name: "Cents", serviceType: "HOTSPOT", price: "10.50" });
    await expect(startHotspotPurchase(slug, { packageId: cents.id, phone, routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(startHotspotPurchase(slug, { packageId: hour.id, phone: "0201234567", routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await buy(slug, org.organization.id, { packageId: hour.id, phone: tel(), routerId: router.id });
    const sub = await db.subscription.findFirstOrThrow({ where: { organizationId: org.organization.id, serviceType: "HOTSPOT" }, include: { subscriber: true } });
    await applySubscriptionAction(ctx, sub.id, "suspend", { reason: "Abuse" });
    await expect(startHotspotPurchase(slug, { packageId: hour.id, phone: `0${sub.subscriber.phone.slice(3)}`, routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringContaining("suspended") });

    process.env.APP_ENV = "production";
    await expect(simulateHotspotPayment(slug, { attemptId: a.attemptId, token: a.token, outcome: "success" }, meta())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("grants a free trial once per phone and device within the cool-down", async () => {
    const { org, ctx, slug, router } = await setup();
    const trial = await createPackage(ctx, { name: "Try 15 min", serviceType: "HOTSPOT", kind: "TRIAL", price: "0", billingUnit: "MINUTE", billingCount: 15, trialCooldownDays: 30, uploadKbps: 2000, downloadKbps: 2000 });
    await drain(org.organization.id);
    const phone = tel();
    const first = await startHotspotPurchase(slug, { packageId: trial.id, phone, mac: "AA:BB:CC:00:00:01", routerId: router.id, requestId: randomUUID() }, meta());
    expect(first).toMatchObject({ trial: true, grant: { packageName: "Try 15 min" } });
    expect(await db.invoice.count({ where: { organizationId: org.organization.id } })).toBe(0);
    await drain(org.organization.id);
    expect(fake.tables["/ip/hotspot/user"]!.length).toBe(1);
    await expect(startHotspotPurchase(slug, { packageId: trial.id, phone, routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(startHotspotPurchase(slug, { packageId: trial.id, phone: tel(), mac: "AA:BB:CC:00:00:01", routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await startHotspotPurchase(slug, { packageId: trial.id, phone: tel(), mac: "AA:BB:CC:00:00:02", routerId: router.id, requestId: randomUUID() }, meta())).toMatchObject({ trial: true });
  });

  it("device plans let the TV's MAC through and remove it at expiry", async () => {
    const { org, ctx, slug, router } = await setup();
    const tv = await createPackage(ctx, { name: "TV month", serviceType: "HOTSPOT", kind: "DEVICE", price: "600", billingUnit: "MONTH", billingCount: 1 });
    await expect(startHotspotPurchase(slug, { packageId: tv.id, phone: tel(), routerId: router.id, requestId: randomUUID() }, meta())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await buy(slug, org.organization.id, { packageId: tv.id, phone: tel(), routerId: router.id, deviceMac: "a4:83:e7:11:22:33" });
    const sub = await db.subscription.findFirstOrThrow({ where: { organizationId: org.organization.id, packageId: tv.id } });
    expect(sub).toMatchObject({ networkMac: "A4:83:E7:11:22:33", networkStatus: "ACTIVE" });
    expect(fake.tables["/ip/hotspot/ip-binding"]).toEqual([expect.objectContaining({ "mac-address": "A4:83:E7:11:22:33", type: "bypassed" })]);
    await db.subscription.update({ where: { id: sub.id }, data: { currentPeriodStart: new Date(Date.now() - 31 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 1000) } });
    await db.paymentAttempt.updateMany({ where: { subscriptionId: sub.id }, data: { createdAt: new Date(Date.now() - 3_600_000) } });
    await expireDueSubscriptions(org.organization.id, systemContext(org.organization.id, "test", "expire-2"));
    await drain(org.organization.id);
    expect(fake.tables["/ip/hotspot/ip-binding"]).toEqual([]);
  });

  it("switches scheduled plans off outside their window and back on inside it", async () => {
    const { org, ctx, slug, router } = await setup();
    const nowLocal = new Date(Date.now() + 3 * 3_600_000);
    const start = (nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes() + 1440 - 30) % 1440; // opened 30 minutes ago
    const night = await createPackage(ctx, { name: "Window", serviceType: "HOTSPOT", price: "30", billingUnit: "HOUR", billingCount: 8, scheduleEnabled: true, scheduleStartMinute: start, scheduleEndMinute: (start + 60) % 1440 });
    await buy(slug, org.organization.id, { packageId: night.id, phone: tel(), routerId: router.id });
    const sub = await db.subscription.findFirstOrThrow({ where: { organizationId: org.organization.id, packageId: night.id } });
    expect(sub.networkStatus).toBe("ACTIVE");
    expect(await enforcePlanSchedules(org.organization.id)).toMatchObject({ switched: 0 });
    expect(await enforcePlanSchedules(org.organization.id, new Date(Date.now() + 45 * 60_000))).toMatchObject({ switched: 1 });
    await drain(org.organization.id);
    expect(fake.tables["/ip/hotspot/user"]!.find((u) => u.name === sub.networkUsername)!.disabled).toBe("yes");
    expect(await enforcePlanSchedules(org.organization.id, new Date(Date.now() + 23 * 3_600_000 + 50 * 60_000))).toMatchObject({ switched: 1 });
  });

  it("requires a same-origin request on the public purchase route", async () => {
    const { slug, router, hour } = await setup();
    const params = { params: Promise.resolve({ org: slug }) };
    const body = { packageId: hour.id, phone: tel(), routerId: router.id, requestId: randomUUID() };
    expect((await purchaseRoute(request(`/api/v1/hotspot/${slug}/purchase`, { body, origin: "https://evil.example" }), params)).status).toBe(403);
    expect((await purchaseRoute(request(`/api/v1/hotspot/${slug}/purchase`, { body }), params)).status).toBe(201);
  });
});
