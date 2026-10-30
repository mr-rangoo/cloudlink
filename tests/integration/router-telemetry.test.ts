import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput, syncRouterPlans } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { createRouter, getRouter, listRouterAlerts, runRouterHealthChecks, updateRouter } from "@/server/services/routers";
import { provisionSubscriptionNetwork, requestRouterOperation } from "@/server/services/network";
import { pruneRouterTelemetry, routerReport, routerSnapshots, routerTelemetry, TELEMETRY_RETENTION_DAYS } from "@/server/services/router-insights";
import { manualPaymentInput, recordManualPayment } from "@/server/services/payments";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { GET as telemetryRoute } from "@/app/api/v1/routers/[id]/telemetry/route";
import { FakeRouterOs } from "../support/fake-routeros";
import { contextFor, createOrg, createStaff, request, sessionFor } from "./fixtures";

const fake = new FakeRouterOs();
let phoneSeq = 0;
const nextPhone = () => `07${String(31_000_000 + phoneSeq++).padStart(8, "0")}`;
const ENV_KEYS = ["NETWORK_ADAPTER", "ROUTEROS_TIMEOUT_MS", "MIKROTIK_ALLOWED_NETWORKS", "MIKROTIK_CONNECTION_MODE", "APP_URL"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NETWORK_ADAPTER = "routeros";
  process.env.ROUTEROS_TIMEOUT_MS = "400";
  process.env.MIKROTIK_ALLOWED_NETWORKS = "";
  process.env.MIKROTIK_CONNECTION_MODE = "api";
  process.env.APP_URL = "https://billing.example.net";
  fake.reset();
  fake.seed("/interface", { name: "ether1", type: "ether", running: "true" });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Run every due background operation (retries included). */
async function drain(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await db.backgroundOperation.updateMany({ where: { status: "FAILED" }, data: { runAfter: new Date(0) } });
    const due = await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED", "FAILED"] }, runAfter: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
    if (!due.length) return;
    for (const op of due) await runOperation(op.id, operationHandlers);
  }
}

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(
    ctx,
    packageInput.parse({ name: "Home 10", serviceType: "PPPOE", price: "2500.00", billingUnit: "MONTH", billingCount: 1, downloadKbps: 10000, uploadKbps: 5000, networkProfile: "home-10m" }),
  );
  const router = await createRouter(ctx, { name: "Core-1", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: true });
  return { org, ctx, pkg, router };
}

/** Request a router action as staff and run it to completion. */
async function act(ctx: Awaited<ReturnType<typeof contextFor>>, routerId: string, input: Parameters<typeof requestRouterOperation>[2]) {
  const op = await requestRouterOperation(ctx, routerId, input);
  await drain();
  return db.networkOperation.findUniqueOrThrow({ where: { id: op.id } });
}

const check = (checks: Array<{ id: string; status: string }>, id: string) => checks.find((c) => c.id === id)?.status;

describe("router telemetry", () => {
  it("stores a sample per health check with resources and uplink traffic", async () => {
    const { org, ctx, router } = await setup();
    await runRouterHealthChecks(org.organization.id);
    const [sample] = await db.routerMetricSample.findMany({ where: { routerId: router.id } });
    expect(sample).toMatchObject({ reachable: true, simulated: false, cpuLoad: 7, memoryUsedPct: 25, diskUsedPct: 25, uptimeSeconds: 3 * 86400 + 4 * 3600, rxBps: BigInt(18_500_000), txBps: BigInt(2_400_000), sessions: 0 });
    expect(Number(sample!.temperatureC)).toBe(41);
    expect(sample!.responseMs).toBeGreaterThanOrEqual(0);
    expect(fake.commands().some((c) => c.startsWith("/interface/monitor-traffic =interface=ether1"))).toBe(true);

    // A configured uplink that does not exist leaves traffic empty instead of failing the check.
    await updateRouter(ctx, router.id, { uplinkInterface: "sfp-sfpplus1" });
    await runRouterHealthChecks(org.organization.id);
    const latest = await db.routerMetricSample.findFirstOrThrow({ where: { routerId: router.id }, orderBy: { takenAt: "desc" } });
    expect(latest).toMatchObject({ reachable: true, rxBps: null, txBps: null, cpuLoad: 7 });
    await expect(updateRouter(ctx, router.id, { uplinkInterface: "ether1; /system reset" })).rejects.toThrow();

    const t = await routerTelemetry(ctx, router.id, { range: "24h" });
    expect(t).toMatchObject({ checks: 2, availability: 100, simulated: false, latest: { reachable: true }, incidents: [] });
    expect(t.score.score).toBeGreaterThanOrEqual(85);
    expect(t.score.grade).toBe("good");
    expect(t.series.filter((p) => p.checks > 0).at(-1)).toMatchObject({ cpu: 7, reachablePct: 100 });
    expect(t.heatmap).toHaveLength(7);
  });

  it("maintenance mode records the outage but raises no offline alert", async () => {
    const { org, ctx, router } = await setup();
    await runRouterHealthChecks(org.organization.id);
    await updateRouter(ctx, router.id, { maintenanceMode: true, maintenanceNote: "Moving the rack", username: "cloudlink", password: "wrong-password" });
    await runRouterHealthChecks(org.organization.id);
    expect((await getRouter(ctx, router.id)).status).toBe("OFFLINE");
    expect((await listRouterAlerts(ctx, { status: "OPEN", page: 1, pageSize: 25 })).total).toBe(0);
    const t = await routerTelemetry(ctx, router.id, { range: "24h" });
    expect(t.availability).toBe(50);
    expect(t.incidents).toEqual([expect.objectContaining({ endedAt: null, failedChecks: 1 })]);
    expect(t.score.score).toBeLessThanOrEqual(25);
    expect(t.score.cap).toMatch(/latest check/);

    await updateRouter(ctx, router.id, { maintenanceMode: false });
    await runRouterHealthChecks(org.organization.id);
    expect((await listRouterAlerts(ctx, { status: "OPEN", page: 1, pageSize: 25 })).rows).toEqual([expect.objectContaining({ type: "ROUTER_OFFLINE" })]);
  });

  it("the mock adapter stores simulated samples, never mixed up with real readings", async () => {
    process.env.NETWORK_ADAPTER = "mock";
    const { org, ctx, router } = await setup();
    await runRouterHealthChecks(org.organization.id);
    const sample = await db.routerMetricSample.findFirstOrThrow({ where: { routerId: router.id } });
    expect(sample.simulated).toBe(true);
    expect(sample.cpuLoad).not.toBeNull();
    expect((await getRouter(ctx, router.id)).status).toBe("UNKNOWN");
    expect((await routerTelemetry(ctx, router.id, { range: "7d" })).simulated).toBe(true);

    const op = await act(ctx, router.id, { type: "router.diagnose" });
    expect(op.status).toBe("SIMULATED");
    const snaps = await routerSnapshots(ctx, router.id);
    expect(snaps.diagnosis).toMatchObject({ simulated: true });
    expect(fake.commands()).toEqual([]);
  });

  it("prunes samples and snapshots past the retention window", async () => {
    const { org, router } = await setup();
    const old = new Date(Date.now() - (TELEMETRY_RETENTION_DAYS + 1) * 86_400_000);
    await db.routerMetricSample.create({ data: { organizationId: org.organization.id, routerId: router.id, takenAt: old, reachable: true } });
    await db.routerMetricSample.create({ data: { organizationId: org.organization.id, routerId: router.id, takenAt: new Date(), reachable: true } });
    await db.routerSnapshot.create({ data: { organizationId: org.organization.id, routerId: router.id, kind: "logs", data: { lines: [] }, takenAt: old } });
    expect(await pruneRouterTelemetry(org.organization.id)).toEqual({ samples: 1, snapshots: 1 });
    expect(await db.routerMetricSample.count({ where: { routerId: router.id } })).toBe(1);
  });
});

describe("router actions", () => {
  it("diagnoses the router, then fixes clock, walled garden, login page and plans, and diagnoses clean", async () => {
    const { ctx, router } = await setup();
    fake.seed("/ip/hotspot", { name: "hs1", interface: "bridge-lan", disabled: "false" });
    fake.seed("/ip/hotspot/profile", { name: "hsprof1", "html-directory": "flash/hotspot", "login-by": "cookie,http-chap" });
    fake.seed("/interface/pppoe-server/server", { "service-name": "pppoe", interface: "ether2", disabled: "false" });
    fake.seed("/ip/service", { name: "api", port: "8728", disabled: "false", address: "10.0.0.0/8" });

    let op = await act(ctx, router.id, { type: "router.diagnose" });
    expect(op).toMatchObject({ status: "SUCCEEDED", verification: "NOT_SUPPORTED" });
    let checks = ((await routerSnapshots(ctx, router.id)).diagnosis!.data as { checks: Array<{ id: string; status: string; detail: string }> }).checks;
    expect(check(checks, "api")).toBe("ok");
    expect(check(checks, "pppoe")).toBe("ok");
    expect(check(checks, "hotspot")).toBe("ok");
    expect(check(checks, "api-access")).toBe("ok");
    expect(check(checks, "clock")).toBe("warning");
    expect(check(checks, "ntp")).toBe("warning");
    expect(check(checks, "login")).toBe("warning");
    expect(check(checks, "walled-garden")).toBe("warning");
    expect(check(checks, "profiles")).toBe("warning");
    expect(checks.find((c) => c.id === "profiles")!.detail).toContain("home-10m");

    op = await act(ctx, router.id, { type: "router.clock" });
    expect(op).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED" });
    expect(fake.clock["time-zone-name"]).toBe("Africa/Nairobi");
    expect(fake.ntp).toMatchObject({ enabled: "yes", servers: "pool.ntp.org" });

    op = await act(ctx, router.id, { type: "hotspot.walled_garden" });
    expect(op).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED" });
    await act(ctx, router.id, { type: "hotspot.walled_garden" }); // repeatable: replaces Cloudlink's entries
    expect(fake.tables["/ip/hotspot/walled-garden"]).toEqual([expect.objectContaining({ "dst-host": "billing.example.net", comment: "cloudlink" })]);
    expect(fake.tables["/ip/hotspot/walled-garden/ip"]).toEqual([expect.objectContaining({ "dst-host": "billing.example.net", action: "accept" })]);

    op = await act(ctx, router.id, { type: "hotspot.login_page" });
    expect(op).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED" });
    expect(fake.tables["/file"]).toEqual([expect.objectContaining({ name: "flash/hotspot/login.html" })]);
    expect(fake.commands()).toContain(`/tool/fetch =url=https://billing.example.net/api/v1/hotspot-files/${router.id}/login.html =dst-path=flash/hotspot/login.html`);
    expect(fake.tables["/ip/hotspot/profile"]![0]!["login-by"]).toContain("http-pap");

    await syncRouterPlans(ctx, router.id);
    await drain();
    op = await act(ctx, router.id, { type: "router.diagnose" });
    checks = ((await routerSnapshots(ctx, router.id)).diagnosis!.data as { checks: Array<{ id: string; status: string; detail: string }> }).checks;
    expect(checks.filter((c) => c.status !== "ok").map((c) => c.id)).toEqual([]);
    expect(op.resultDetail).toMatch(/0 warning\(s\), 0 problem\(s\)/);
  });

  it("renames the router, reads its logs and reboots it once", async () => {
    const { ctx, router } = await setup();
    for (let i = 0; i < 120; i++) fake.seed("/log", { time: `12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, topics: "system,info", message: `line ${i}` });

    let op = await act(ctx, router.id, { type: "router.identity", name: "Core-1 Westlands" });
    expect(op).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED" });
    expect(fake.identity).toBe("Core-1 Westlands");
    expect((await getRouter(ctx, router.id)).identity).toBe("Core-1 Westlands");
    await expect(requestRouterOperation(ctx, router.id, { type: "router.identity", name: "bad;name" })).rejects.toThrow();

    op = await act(ctx, router.id, { type: "router.logs" });
    expect(op.status).toBe("SUCCEEDED");
    const lines = ((await routerSnapshots(ctx, router.id)).logs!.data as { lines: Array<{ message: string }> }).lines;
    expect(lines).toHaveLength(100);
    expect(lines[0]!.message).toBe("line 119"); // newest first

    const reboot = await requestRouterOperation(ctx, router.id, { type: "router.reboot" });
    await expect(requestRouterOperation(ctx, router.id, { type: "router.reboot" })).rejects.toMatchObject({ code: "CONFLICT" });
    await drain();
    expect(fake.reboots).toBe(1);
    expect(await db.networkOperation.findUniqueOrThrow({ where: { id: reboot.id } })).toMatchObject({ status: "SUCCEEDED", verification: "NOT_SUPPORTED" });
    const followUp = await db.backgroundOperation.findFirstOrThrow({ where: { dedupeKey: `routers.healthcheck:${router.id}:reboot:${reboot.id}` } });
    expect(followUp.runAfter.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // An unreachable router: the reboot fails once and is not retried later.
    fake.failures.push({ match: "/login", kind: "drop" });
    const failed = await requestRouterOperation(ctx, router.id, { type: "router.reboot" });
    await drain();
    expect(await db.networkOperation.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(fake.reboots).toBe(1);
  });

  it("falls back to RouterOS 6 parameters when syncing the clock", async () => {
    const { ctx, router } = await setup();
    fake.v6 = true;
    const op = await act(ctx, router.id, { type: "router.clock" });
    expect(op).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED" });
    expect(fake.clock["time-zone-name"]).toBe("Africa/Nairobi");
    expect(fake.ntp).toMatchObject({ enabled: "yes", "server-dns-names": "pool.ntp.org" });
  });

  it("refuses hotspot actions without a hotspot or APP_URL, and enforces permissions and tenancy", async () => {
    const { org, ctx, router } = await setup();
    delete process.env.APP_URL;
    await expect(requestRouterOperation(ctx, router.id, { type: "hotspot.walled_garden" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    process.env.APP_URL = "https://billing.example.net";
    await updateRouter(ctx, router.id, { hotspotEnabled: false });
    await expect(requestRouterOperation(ctx, router.id, { type: "hotspot.login_page" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const support = await createStaff(org.organization.id, "support");
    const supportCtx = await contextFor(support.user.id, org.organization.id);
    await expect(requestRouterOperation(supportCtx, router.id, { type: "router.diagnose" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(routerTelemetry(supportCtx, router.id, { range: "24h" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await routerSnapshots(supportCtx, router.id)).toEqual({ logs: null, diagnosis: null, pending: { logs: false, diagnosis: false } });

    const other = await createOrg("Other ISP");
    const otherCtx = await contextFor(other.owner.id, other.organization.id);
    await expect(routerTelemetry(otherCtx, router.id, { range: "24h" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(routerReport(otherCtx, router.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestRouterOperation(otherCtx, router.id, { type: "router.reboot" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const res = await telemetryRoute(request(`/api/v1/routers/${router.id}/telemetry?range=7d`, { token: await sessionFor(other.owner.id, other.organization.id) }), { params: Promise.resolve({ id: router.id }) });
    expect(res.status).toBe(404);
    expect(fake.reboots).toBe(0);
  });
});

describe("router reports", () => {
  it("reports collections, sessions and peak hours; collections only for staff who may view payments", async () => {
    const { org, ctx, pkg, router } = await setup();
    const { subscriber, subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Amina", phone: nextPhone(), packageId: pkg.id, activateSubscription: true }));
    await provisionSubscriptionNetwork(ctx, subscription!.id, { routerId: router.id });
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: subscriber.id, amount: "2500", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    const allocated = await db.paymentAllocation.aggregate({ where: { status: "ACTIVE", invoice: { subscriptionId: subscription!.id } }, _sum: { amount: true } });
    const started = new Date(Date.now() - 2 * 3600_000);
    await db.networkSession.create({
      data: { organizationId: org.organization.id, routerId: router.id, kind: "PPPOE", username: "a1", externalId: "*1", source: "router_api", startedAt: started, lastSeenAt: new Date(), endedAt: new Date(started.getTime() + 1800_000) },
    });
    await db.routerMetricSample.create({ data: { organizationId: org.organization.id, routerId: router.id, takenAt: new Date(), reachable: true, sessions: 4 } });

    const report = await routerReport(ctx, router.id);
    expect(report.collections).toHaveLength(6);
    expect(report.collections!.at(-1)!.amount).toBe(Number(allocated._sum.amount ?? 0).toFixed(2));
    expect(Number(report.collections!.at(-1)!.amount)).toBeGreaterThan(0);
    expect(report.sessions).toMatchObject({ total: 1, uniqueUsers: 1, averageSeconds: 1800 });
    expect(report.peakHours.filter((h) => h.sessions !== null)).toEqual([expect.objectContaining({ sessions: 4 })]);
    expect(report.subscriptions.ACTIVE).toBe(1);

    const tech = await createStaff(org.organization.id, "technician");
    const techReport = await routerReport(await contextFor(tech.user.id, org.organization.id), router.id);
    expect(techReport.collections).toBeNull();
    expect(techReport.sessions.total).toBe(1);
  });
});
