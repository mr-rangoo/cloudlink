import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, duplicatePackage, getPackage, packageCatalogue, syncPackageToRouters, syncRouterPlans, updatePackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { createRouter } from "@/server/services/routers";
import { provisionSubscriptionNetwork } from "@/server/services/network";
import { recordManualPayment } from "@/server/services/payments";
import { generateBatch, redeemVoucher } from "@/server/services/vouchers";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { POST as syncRoute } from "@/app/api/v1/packages/[id]/sync/route";
import { FakeRouterOs } from "../support/fake-routeros";
import { contextFor, createOrg, createStaff, request, sessionFor } from "./fixtures";

const fake = new FakeRouterOs();
let phoneSeq = 0;
const nextPhone = () => `07${String(31_000_000 + phoneSeq++).padStart(8, "0")}`;
const ENV_KEYS = ["NETWORK_ADAPTER", "ROUTEROS_TIMEOUT_MS", "MIKROTIK_ALLOWED_NETWORKS", "MIKROTIK_CONNECTION_MODE"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NETWORK_ADAPTER = "routeros";
  process.env.ROUTEROS_TIMEOUT_MS = "400";
  process.env.MIKROTIK_ALLOWED_NETWORKS = "";
  process.env.MIKROTIK_CONNECTION_MODE = "api";
  fake.reset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function drain(organizationId: string) {
  for (let i = 0; i < 10; i++) {
    const due = await db.backgroundOperation.findMany({ where: { organizationId, status: { in: ["PENDING", "QUEUED"] }, runAfter: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
    if (!due.length) return;
    for (const op of due) await runOperation(op.id, operationHandlers);
  }
}

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  return { org, ctx };
}

const router = (ctx: Awaited<ReturnType<typeof setup>>["ctx"], name: string, opts: { hotspot?: boolean; pppoe?: boolean } = {}) =>
  createRouter(ctx, { name, host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: opts.hotspot ?? true, pppoeEnabled: opts.pppoe ?? true });

const hotspotPlan = {
  name: "Fast 1 hour",
  serviceType: "HOTSPOT" as const,
  price: "10",
  billingUnit: "HOUR" as const,
  billingCount: 1,
  uploadKbps: 5000,
  downloadKbps: 5000,
  deviceLimit: 3,
  burstUploadKbps: 10000,
  burstDownloadKbps: 10000,
  burstThresholdUploadKbps: 4000,
  burstThresholdDownloadKbps: 4000,
  burstTimeSeconds: 30,
};

describe("plans", () => {
  it("stores burst, schedule, labels and a stable profile name; a PATCH changes only what it sends", async () => {
    const { ctx } = await setup();
    const plan = await createPackage(ctx, { ...hotspotPlan, taxRate: "16", highlight: "POPULAR", availability: "HIDDEN", scheduleEnabled: true, scheduleStartMinute: 1380, scheduleEndMinute: 360, scheduleDays: 0b0010000 });
    expect(plan).toMatchObject({ availability: "HIDDEN", listed: false, status: "ACTIVE", highlight: "POPULAR", networkProfile: "cl-fast-1-hour", burstTimeSeconds: 30, scheduleStartMinute: 1380 });
    expect(plan.taxRate.toString()).toBe("16");

    const renamed = await updatePackage(ctx, plan.id, { name: "Fast hour" });
    expect(renamed.taxRate.toString()).toBe("16"); // regression: absent fields used to be reset to their defaults
    expect(renamed).toMatchObject({ billingUnit: "HOUR", billingCount: 1, highlight: "POPULAR", networkProfile: "cl-fast-1-hour", scheduleEnabled: true });

    const off = await updatePackage(ctx, plan.id, { scheduleEnabled: false, availability: "OFF" });
    expect(off).toMatchObject({ availability: "OFF", scheduleStartMinute: null, scheduleEndMinute: null, scheduleDays: null });
  });

  it("enforces plan rules on create and on the merged result of an update", async () => {
    const { ctx } = await setup();
    const reject = (p: Promise<unknown>, path: string) => expect(p).rejects.toMatchObject({ code: "VALIDATION_ERROR", fields: expect.arrayContaining([expect.objectContaining({ path })]) });
    await reject(createPackage(ctx, { name: "Free", serviceType: "HOTSPOT", price: "0", billingUnit: "HOUR" }), "price");
    expect((await createPackage(ctx, { name: "Try it", serviceType: "HOTSPOT", kind: "TRIAL", price: "0", billingUnit: "MINUTE", billingCount: 15, trialCooldownDays: 30 })).trialCooldownDays).toBe(30);
    await reject(createPackage(ctx, { name: "Bundle", serviceType: "HOTSPOT", kind: "DATA", price: "20", billingUnit: "DAY" }), "dataQuotaMb");
    await reject(createPackage(ctx, { name: "Quick PPP", serviceType: "PPPOE", price: "20", billingUnit: "MINUTE", billingCount: 30 }), "billingUnit");
    await reject(createPackage(ctx, { name: "Half", serviceType: "HOTSPOT", price: "20", uploadKbps: 1000 }), "uploadKbps");
    await reject(createPackage(ctx, { ...hotspotPlan, name: "Half burst", burstTimeSeconds: null }), "burstDownloadKbps");
    await reject(createPackage(ctx, { ...hotspotPlan, name: "Low burst", burstDownloadKbps: 4000 }), "burstDownloadKbps");
    await reject(createPackage(ctx, { ...hotspotPlan, name: "Fup", fupEnabled: true, fupThresholdMb: 1024, fupAction: "THROTTLE" }), "fupDownloadKbps");
    await reject(createPackage(ctx, { ...hotspotPlan, name: "Fup fast", fupEnabled: true, fupThresholdMb: 1024, fupAction: "THROTTLE", fupUploadKbps: 6000, fupDownloadKbps: 6000 }), "fupDownloadKbps");
    await reject(createPackage(ctx, { ...hotspotPlan, name: "Same", scheduleEnabled: true, scheduleStartMinute: 60, scheduleEndMinute: 60 }), "scheduleEndMinute");
    await reject(createPackage(ctx, { name: "PPP data", serviceType: "PPPOE", kind: "DATA", price: "20", dataQuotaMb: 1024 }), "kind");
    const ok = await createPackage(ctx, { ...hotspotPlan, name: "Ok" });
    await reject(updatePackage(ctx, ok.id, { burstDownloadKbps: 3000 }), "burstDownloadKbps");
    await reject(updatePackage(ctx, ok.id, { price: "0" }), "price");
  });

  it("only accepts routers of the same organization in a restriction (service and database)", async () => {
    const { ctx } = await setup();
    const other = await setup();
    const foreign = await router(other.ctx, "Other-1");
    await expect(createPackage(ctx, { ...hotspotPlan, routerIds: [foreign.id] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const plan = await createPackage(ctx, hotspotPlan);
    await expect(db.packageRouter.create({ data: { packageId: plan.id, routerId: foreign.id, organizationId: ctx.organizationId } })).rejects.toThrow();
  });

  it("pushes the hotspot profile (rate limit with burst, shared users) to routers and verifies it by read-back", async () => {
    const { org, ctx } = await setup();
    const r1 = await router(ctx, "Hs-1");
    const plan = await createPackage(ctx, hotspotPlan);
    const op = await db.networkOperation.findFirstOrThrow({ where: { organizationId: org.organization.id, type: "profile.sync" } });
    expect(op).toMatchObject({ routerId: r1.id, status: "QUEUED" });
    await drain(org.organization.id);
    const done = await db.networkOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(done).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED" });
    const profile = fake.tables["/ip/hotspot/user/profile"]!.find((p) => p.name === "cl-fast-1-hour");
    expect(profile).toMatchObject({ "rate-limit": "5M/5M 10M/10M 4M/4M 30/30", "shared-users": "3" });

    // A changed speed is pushed again and updates the same profile.
    await updatePackage(ctx, plan.id, { uploadKbps: 2000, downloadKbps: 8000, burstUploadKbps: null, burstDownloadKbps: null, burstThresholdUploadKbps: null, burstThresholdDownloadKbps: null, burstTimeSeconds: null });
    await drain(org.organization.id);
    expect(fake.tables["/ip/hotspot/user/profile"]!.filter((p) => p.name === "cl-fast-1-hour")).toEqual([expect.objectContaining({ "rate-limit": "2M/8M" })]);
    // A description-only edit does not touch routers.
    const before = await db.networkOperation.count({ where: { organizationId: org.organization.id, type: "profile.sync" } });
    await updatePackage(ctx, plan.id, { description: "Our most popular plan" });
    expect(await db.networkOperation.count({ where: { organizationId: org.organization.id, type: "profile.sync" } })).toBe(before);
  });

  it("supersedes queued pushes, respects the router restriction and pushes PPP profiles to PPPoE routers only", async () => {
    const { org, ctx } = await setup();
    const a = await router(ctx, "Ppp-A", { hotspot: false });
    const b = await router(ctx, "Ppp-B", { hotspot: false });
    await router(ctx, "Hs-only", { pppoe: false });
    const plan = await createPackage(ctx, { name: "Home 10", serviceType: "PPPOE", price: "2500", uploadKbps: 5000, downloadKbps: 10000, routerIds: [a.id] });
    let ops = await db.networkOperation.findMany({ where: { organizationId: org.organization.id, type: "profile.sync" } });
    expect(ops.map((o) => o.routerId)).toEqual([a.id]);
    await updatePackage(ctx, plan.id, { downloadKbps: 20000 });
    ops = await db.networkOperation.findMany({ where: { organizationId: org.organization.id, type: "profile.sync" }, orderBy: { createdAt: "asc" } });
    expect(ops.map((o) => o.status)).toEqual(["CANCELLED", "QUEUED"]);
    await drain(org.organization.id);
    expect(fake.tables["/ppp/profile"]!.find((p) => p.name === "cl-home-10")).toMatchObject({ "rate-limit": "5M/20M" });

    // Lifting the restriction pushes to the newly allowed router; router A already has this version of the plan.
    await updatePackage(ctx, plan.id, { routerIds: [] });
    const byRouter = await db.networkOperation.groupBy({ by: ["routerId"], where: { organizationId: org.organization.id, type: "profile.sync", status: "QUEUED" }, _count: { _all: true } });
    expect(byRouter.map((g) => g.routerId)).toEqual([b.id]);

    expect((await syncRouterPlans(ctx, b.id)).queued).toBe(1);
    expect((await syncPackageToRouters(ctx, plan.id)).queued).toBe(2);
  });

  it("refuses provisioning on a router outside the restriction and voucher logins outside the schedule", async () => {
    process.env.NETWORK_ADAPTER = "mock";
    const { ctx } = await setup();
    const allowed = await router(ctx, "Allowed");
    const elsewhere = await router(ctx, "Elsewhere");
    const plan = await createPackage(ctx, { name: "Fibre", serviceType: "PPPOE", price: "2000", routerIds: [allowed.id] });
    const { subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Wanjiru", phone: nextPhone(), packageId: plan.id, activateSubscription: true }));
    await expect(provisionSubscriptionNetwork(ctx, subscription!.id, { routerId: elsewhere.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await provisionSubscriptionNetwork(ctx, subscription!.id, { routerId: allowed.id })).operation.type).toBe("pppoe.enable");

    // A window that is closed right now (it opens in two hours, local time).
    const nowLocal = new Date(Date.now() + 3 * 3_600_000);
    const startMinute = ((nowLocal.getUTCHours() + 2) % 24) * 60;
    const night = await createPackage(ctx, { name: "Night", serviceType: "HOTSPOT", price: "30", billingUnit: "HOUR", billingCount: 8, scheduleEnabled: true, scheduleStartMinute: startMinute, scheduleEndMinute: (startMinute + 60) % 1440 });
    const { codes } = await generateBatch(ctx, { packageId: night.id, quantity: 1, codeLength: 10, routerId: allowed.id });
    await expect(redeemVoucher(ctx, { code: codes[0]! }, "staff")).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringContaining("only available") });
    expect(await db.voucher.count({ where: { organizationId: ctx.organizationId, status: "UNUSED" } })).toBe(1);
  });

  it("reports counts, live subscriptions and 30-day revenue; duplicates start Off", async () => {
    process.env.NETWORK_ADAPTER = "mock";
    const { ctx } = await setup();
    const home = await createPackage(ctx, { name: "Home", serviceType: "PPPOE", price: "1500", uploadKbps: 5000, downloadKbps: 5000 });
    await createPackage(ctx, { name: "Hidden", serviceType: "HOTSPOT", price: "50", availability: "HIDDEN" });
    await createPackage(ctx, { name: "Bundle", serviceType: "HOTSPOT", kind: "DATA", price: "20", dataQuotaMb: 1024, availability: "OFF" });
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Otieno", phone: nextPhone(), packageId: home.id, activateSubscription: true }));
    await recordManualPayment(ctx, { subscriberId: subscriber.id, amount: "1500.00", method: "CASH", receivedAt: new Date(), autoAllocate: true });

    const cat = await packageCatalogue(ctx, { type: "ALL", view: "current" });
    expect(cat.stats).toMatchObject({ all: 3, live: 1, hidden: 1, off: 1, subscribers: 1 });
    expect(cat.typeCounts).toMatchObject({ PPPOE: 1, HOTSPOT: 1, DATA: 1 });
    const row = cat.rows.find((r) => r.id === home.id)!;
    expect(row).toMatchObject({ planType: "PPPOE", availability: "LIVE", activeSubscriptions: 1, revenue30d: "1500.00" });
    expect((await packageCatalogue(ctx, { type: "DATA", view: "current" })).rows.map((r) => r.name)).toEqual(["Bundle"]);

    const copy = await duplicatePackage(ctx, home.id);
    expect(copy).toMatchObject({ name: "Home (copy)", availability: "OFF", networkProfile: "cl-home-copy" });
    expect((await duplicatePackage(ctx, home.id)).name).toBe("Home (copy 2)");
    expect((await getPackage(ctx, copy.id)).price.toString()).toBe("1500");

    // Staff without payments.read or reports.read do not see revenue.
    const { user } = await createStaff(ctx.organizationId, "sales");
    const sales = await contextFor(user.id, ctx.organizationId);
    expect((await packageCatalogue(sales, { type: "ALL", view: "current" })).rows[0]!.revenue30d).toBeNull();
  });

  it("requires network.operate to push a plan", async () => {
    process.env.NETWORK_ADAPTER = "mock";
    const { org, ctx } = await setup();
    await router(ctx, "Hs-1");
    const plan = await createPackage(ctx, hotspotPlan);
    const { user } = await createStaff(org.organization.id, "sales");
    const params = { params: Promise.resolve({ id: plan.id }) };
    const denied = await syncRoute(request(`/api/v1/packages/${plan.id}/sync`, { method: "POST", token: await sessionFor(user.id, org.organization.id) }), params);
    expect(denied.status).toBe(403);
    const ok = await syncRoute(request(`/api/v1/packages/${plan.id}/sync`, { method: "POST", token: await sessionFor(org.owner.id, org.organization.id) }), params);
    expect(ok.status).toBe(202);
  });
});
