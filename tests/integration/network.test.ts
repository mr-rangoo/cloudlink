import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { applySubscriptionAction } from "@/server/services/subscriptions";
import { createRouter, getRouter, listRouterAlerts, runRouterHealthChecks, updateRouter } from "@/server/services/routers";
import {
  cancelNetworkOperation,
  deprovisionSubscriptionNetwork,
  getNetworkOperation,
  listNetworkOperations,
  monitorNetworkOperations,
  provisionSubscriptionNetwork,
  requestRouterOperation,
  retryNetworkOperation,
  revealNetworkCredentials,
  subscriptionNetwork,
  syncNetworkSessions,
} from "@/server/services/network";
import { generateBatch, redeemVoucher } from "@/server/services/vouchers";
import { staffAlerts } from "@/server/services/alerts";
import { integrationStatus } from "@/server/services/integrations";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { GET as listRoutersRoute } from "@/app/api/v1/routers/route";
import { POST as routerOperationRoute } from "@/app/api/v1/routers/[id]/operations/route";
import { POST as revealRoute } from "@/app/api/v1/subscriptions/[id]/network/credentials/route";
import { FakeRouterOs } from "../support/fake-routeros";
import { contextFor, createOrg, createStaff, noParams, request, sessionFor } from "./fixtures";

const fake = new FakeRouterOs();
let phoneSeq = 0;
const nextPhone = () => `07${String(20_000_000 + phoneSeq++).padStart(8, "0")}`;
const ENV_KEYS = ["NETWORK_ADAPTER", "ROUTEROS_TIMEOUT_MS", "MIKROTIK_ALLOWED_NETWORKS", "MIKROTIK_CONNECTION_MODE"] as const;
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
  fake.reset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Run every due background operation; with `forceRetries`, also run retries whose backoff has not elapsed. */
async function drain(rounds = 20, forceRetries = true) {
  for (let i = 0; i < rounds; i++) {
    if (forceRetries) await db.backgroundOperation.updateMany({ where: { status: "FAILED" }, data: { runAfter: new Date(0) } });
    const due = await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED", "FAILED"] }, runAfter: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
    if (!due.length) return;
    for (const op of due) await runOperation(op.id, operationHandlers);
  }
}
const runOnce = () => drain(1, false);

async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function setup(opts: { routerName?: string; host?: string } = {}) {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(
    ctx,
    packageInput.parse({ name: "Home 10", serviceType: "PPPOE", price: "2500.00", billingUnit: "MONTH", billingCount: 1, downloadKbps: 10240, uploadKbps: 5120, networkProfile: "home-10m" }),
  );
  const { subscriber, subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Jane", phone: nextPhone(), packageId: pkg.id, activateSubscription: true }));
  const router = await createRouter(ctx, { name: opts.routerName ?? "Core-1", host: opts.host ?? "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass", hotspotEnabled: true });
  return { org, ctx, pkg, subscriber, subscription: subscription!, router, username: subscriber.accountNumber.toLowerCase() };
}

const secret = (name: string) => fake.tables["/ppp/secret"]!.find((r) => r.name === name);
const latestOp = (subscriptionId: string) => db.networkOperation.findFirstOrThrow({ where: { subscriptionId }, orderBy: { createdAt: "desc" } });

describe("router inventory", () => {
  it("stores credentials encrypted, never returns them, and refuses public or hostname addresses", async () => {
    const { org, ctx, router } = await setup();
    expect(Object.keys(router)).not.toContain("username");
    const cred = await db.routerCredential.findUniqueOrThrow({ where: { routerId: router.id } });
    expect(cred.encryptedSecret).not.toContain("router-pass");
    expect(cred.encryptedSecret).not.toContain("cloudlink");

    const res = await listRoutersRoute(request("/api/v1/routers", { token: await sessionFor(org.owner.id, org.organization.id) }), noParams);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("Core-1");
    expect(text).not.toMatch(/router-pass|encryptedSecret/);

    await expect(createRouter(ctx, { name: "Public", host: "41.90.1.1", username: "a", password: "b" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createRouter(ctx, { name: "Dns", host: "core.isp.example", username: "a", password: "b" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    process.env.MIKROTIK_ALLOWED_NETWORKS = "10.50.0.0/16";
    await expect(createRouter(ctx, { name: "Outside", host: "10.60.0.1", username: "a", password: "b" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    process.env.MIKROTIK_CONNECTION_MODE = "api-ssl";
    await expect(createRouter(ctx, { name: "Plain", host: "10.50.0.1", username: "a", password: "b" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await createRouter(ctx, { name: "Tls", host: "10.50.0.1", apiPort: 8729, useTls: true, username: "a", password: "b" })).useTls).toBe(true);
    await expect(createRouter(ctx, { name: "Core-1", host: "10.50.0.2", useTls: true, username: "a", password: "b" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("health checks record identity and raise then resolve an offline alert", async () => {
    const { org, ctx, router } = await setup();
    await runRouterHealthChecks(org.organization.id);
    let r = await getRouter(ctx, router.id);
    expect(r).toMatchObject({ status: "ONLINE", identity: "FakeRouter", routerOsVersion: "7.14.3 (stable)", boardName: "hEX S" });
    const status = Object.fromEntries((await integrationStatus(ctx)).map((x) => [x.key, x]));
    expect(status.mikrotik_routeros).toMatchObject({ status: "ok", mode: "routeros" });
    expect(status.mikrotik_routeros!.detail).toMatch(/1 of 1 router/);

    await updateRouter(ctx, router.id, { username: "cloudlink", password: "wrong-password" });
    await runRouterHealthChecks(org.organization.id);
    r = await getRouter(ctx, router.id);
    expect(r.status).toBe("OFFLINE");
    expect(r.lastError).toMatch(/Login rejected/);
    const alerts = await listRouterAlerts(ctx, { status: "OPEN", page: 1, pageSize: 25 });
    expect(alerts.rows).toEqual([expect.objectContaining({ type: "ROUTER_OFFLINE", routerId: router.id })]);
    expect((await staffAlerts(ctx)).map((a) => a.key)).toContain("network-alerts");

    await updateRouter(ctx, router.id, { username: "cloudlink", password: "router-pass" });
    await runRouterHealthChecks(org.organization.id);
    expect((await getRouter(ctx, router.id)).status).toBe("ONLINE");
    expect((await listRouterAlerts(ctx, { status: "OPEN", page: 1, pageSize: 25 })).total).toBe(0);
  });
});

describe("PPPoE provisioning and lifecycle", () => {
  it("provisions, follows suspend/reactivate, and verifies each change by reading it back", async () => {
    const { ctx, subscription, router, username } = await setup();
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    expect(operation).toMatchObject({ type: "pppoe.enable", status: "QUEUED" });
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("PENDING");

    await drain();
    expect(secret(username)).toMatchObject({ profile: "home-10m", disabled: "no", service: "pppoe" });
    const op = await getNetworkOperation(ctx, operation.id);
    expect(op).toMatchObject({ status: "SUCCEEDED", verification: "VERIFIED", attempts: 1 });
    expect(op.attemptsLog.map((a) => a.outcome)).toEqual(["SUCCESS"]);
    expect((await subscriptionNetwork(ctx, subscription.id)).networkStatus).toBe("ACTIVE");

    // Billing suspension → network disable (separate statuses), active session disconnected.
    fake.addActivePppoe(username);
    await applySubscriptionAction(ctx, subscription.id, "suspend", { reason: "Non-payment" });
    let sub = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(sub.status).toBe("SUSPENDED");
    expect(sub.networkStatus).toBe("PENDING");
    await drain();
    expect(secret(username)!.disabled).toBe("yes");
    expect(fake.tables["/ppp/active"]).toEqual([]);
    const disable = await latestOp(subscription.id);
    expect(disable).toMatchObject({ type: "pppoe.disable", status: "SUCCEEDED", verification: "VERIFIED" });
    expect(disable.resultDetail).toMatch(/1 active session\(s\) disconnected/);
    sub = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(sub.networkStatus).toBe("DISABLED");

    await applySubscriptionAction(ctx, subscription.id, "reactivate");
    await drain();
    expect(secret(username)!.disabled).toBe("no");
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("ACTIVE");
  });

  it("supersedes a queued older request with a newer one so only the latest state is applied", async () => {
    const { ctx, subscription, router, username } = await setup();
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    fake.reset();
    fake.tables["/ppp/secret"]!.push({ ".id": "*99", name: username, profile: "home-10m", disabled: "no", service: "pppoe" });
    await applySubscriptionAction(ctx, subscription.id, "suspend", { reason: "Requested by customer" });
    await applySubscriptionAction(ctx, subscription.id, "reactivate");
    const ops = await db.networkOperation.findMany({ where: { subscriptionId: subscription.id }, orderBy: { createdAt: "asc" } });
    expect(ops.map((o) => [o.type, o.status])).toEqual([
      ["pppoe.enable", "SUCCEEDED"],
      ["pppoe.disable", "CANCELLED"],
      ["pppoe.enable", "QUEUED"],
    ]);
    await drain();
    expect(fake.commands().some((c) => c.includes("=disabled=yes"))).toBe(false);
    expect((await latestOp(subscription.id)).status).toBe("SUCCEEDED");
  });

  it("retries transient failures with a recorded attempt each time", async () => {
    const { ctx, subscription, router } = await setup();
    fake.failures.push({ match: "/ppp/secret/print", kind: "drop" });
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await runOnce();
    let op = await getNetworkOperation(ctx, operation.id);
    expect(op.status).toBe("RETRYING");
    expect(op.attemptsLog).toEqual([expect.objectContaining({ attemptNumber: 1, outcome: "RETRYABLE_ERROR", errorCode: "ROUTER_CLOSED" })]);
    const bg = await db.backgroundOperation.findFirstOrThrow({ where: { type: "network.execute", payload: { path: ["networkOperationId"], equals: operation.id } } });
    expect(bg.status).toBe("FAILED");
    expect(bg.runAfter.getTime()).toBeGreaterThan(Date.now());

    await drain();
    op = await getNetworkOperation(ctx, operation.id);
    expect(op).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(op.attemptsLog.map((a) => a.outcome)).toEqual(["RETRYABLE_ERROR", "SUCCESS"]);

    // A router that stops answering mid-command times out and is retried too.
    fake.failures.push({ match: "/ppp/active/print", kind: "hang" });
    const disconnect = await requestRouterOperation(ctx, router.id, { type: "session.disconnect", kind: "PPPOE", username: "nobody" });
    await runOnce();
    expect((await getNetworkOperation(ctx, disconnect.id)).attemptsLog[0]).toMatchObject({ outcome: "RETRYABLE_ERROR", errorCode: "ROUTER_TIMEOUT" });
    await drain();
    expect((await getNetworkOperation(ctx, disconnect.id)).status).toBe("SUCCEEDED");
  });

  it("fails permanently when the router rejects a change, alerts staff, and allows a retry after the fix", async () => {
    const { ctx, subscription, router, username } = await setup();
    fake.failures.push({ match: "/ppp/secret/add", kind: "trap", message: "input does not match any value of profile" });
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    const failed = await getNetworkOperation(ctx, operation.id);
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(failed.attemptsLog[0]).toMatchObject({ outcome: "PERMANENT_ERROR", errorCode: "ROUTER_TRAP" });
    expect(failed.resultDetail).toMatch(/profile/);
    expect(failed.alerts).toEqual([expect.objectContaining({ type: "OPERATION_FAILED", severity: "critical", status: "OPEN" })]);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("ERROR");
    expect((await db.backgroundOperation.findFirstOrThrow({ where: { type: "network.execute" } })).status).toBe("DEAD");
    expect((await listNetworkOperations(ctx, { status: "ATTENTION", page: 1, pageSize: 25 })).total).toBe(1);

    await retryNetworkOperation(ctx, operation.id);
    await drain();
    const retried = await getNetworkOperation(ctx, operation.id);
    expect(retried).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(retried.alerts.every((a) => a.status === "RESOLVED")).toBe(true);
    expect(secret(username)).toBeDefined();
    await expect(retryNetworkOperation(ctx, operation.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("gives up after the retry limit when the router stays unreachable", async () => {
    const { ctx, subscription } = await setup();
    const dead = await createRouter(ctx, { name: "Edge-down", host: "127.0.0.1", apiPort: await closedPort(), username: "x", password: "y" });
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: dead.id });
    await drain(30);
    const op = await getNetworkOperation(ctx, operation.id);
    expect(op).toMatchObject({ status: "FAILED", attempts: 5 });
    expect(op.attemptsLog.map((a) => a.errorCode)).toEqual(Array(5).fill("ROUTER_REFUSED"));
    expect(op.alerts).toEqual([expect.objectContaining({ type: "OPERATION_FAILED", status: "OPEN" })]);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("ERROR");
  });

  it("cancels queued work, deprovisions, moves routers, and audits credential reveals", async () => {
    const { ctx, subscription, router, username } = await setup();
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    const queued = await latestOp(subscription.id);
    await cancelNetworkOperation(ctx, queued.id, { reason: "Wrong router" });
    expect((await db.networkOperation.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("CANCELLED");
    await drain();
    expect(secret(username)).toBeUndefined(); // the cancelled operation never touched the router

    await requestRouterOperation(ctx, router.id, { type: "pppoe.sync", subscriptionId: subscription.id });
    await drain();
    expect(secret(username)).toBeDefined();

    const creds = await revealNetworkCredentials(ctx, subscription.id);
    expect(creds.username).toBe(username);
    expect(creds.password).toMatch(/^[A-Za-z2-9]{12}$/);
    expect(secret(username)!.password).toBe(creds.password);
    const auditRow = await db.auditLog.findFirstOrThrow({ where: { action: "network.credentials.reveal" } });
    expect(JSON.stringify(auditRow)).not.toContain(creds.password);
    const stored = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(stored.networkPasswordEnc).not.toContain(creds.password);

    // Move to a second router: the old account is removed, the new one created.
    const second = await createRouter(ctx, { name: "Core-2", host: "127.0.0.1", apiPort: fake.port, username: "cloudlink", password: "router-pass" });
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: second.id });
    const ops = await db.networkOperation.findMany({ where: { subscriptionId: subscription.id, status: "QUEUED" }, orderBy: { createdAt: "asc" } });
    expect(ops.map((o) => [o.type, o.routerId])).toEqual([
      ["pppoe.remove", router.id],
      ["pppoe.enable", second.id],
    ]);
    await drain();

    await deprovisionSubscriptionNetwork(ctx, subscription.id, { reason: "Customer left" });
    const cleared = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(cleared).toMatchObject({ networkRouterId: null, networkUsername: null, networkPasswordEnc: null, networkStatus: "NOT_PROVISIONED" });
    await drain();
    expect(secret(username)).toBeUndefined();
    expect((await latestOp(subscription.id))).toMatchObject({ type: "pppoe.remove", status: "SUCCEEDED", verification: "VERIFIED" });
    await expect(revealNetworkCredentials(ctx, subscription.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("sessions, monitoring and hotspot", () => {
  it("syncs sessions from the router and closes sessions that disappear", async () => {
    const { org, ctx, subscription, subscriber, router, username } = await setup();
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    fake.addActivePppoe(username, "10.10.0.9");
    await syncNetworkSessions(org.organization.id);
    let sessions = await db.networkSession.findMany({ where: { routerId: router.id } });
    expect(sessions).toEqual([expect.objectContaining({ username, subscriberId: subscriber.id, address: "10.10.0.9", uptimeSeconds: 3723, source: "router_api", endedAt: null })]);
    expect((await subscriptionNetwork(ctx, subscription.id)).sessions).toHaveLength(1);

    fake.tables["/ppp/active"] = [];
    await syncNetworkSessions(org.organization.id);
    sessions = await db.networkSession.findMany({ where: { routerId: router.id } });
    expect(sessions[0]!.endedAt).not.toBeNull();
    expect(sessions[0]!.externalId).toMatch(/#ended-\d+$/);
  });

  it("raises an alert for operations that stop progressing", async () => {
    const { org, ctx, subscription, router } = await setup();
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await db.networkOperation.update({ where: { id: operation.id }, data: { status: "RUNNING", startedAt: new Date(Date.now() - 20 * 60_000) } });
    expect(await monitorNetworkOperations(org.organization.id)).toEqual({ stuck: 1 });
    expect(await monitorNetworkOperations(org.organization.id)).toEqual({ stuck: 1 });
    expect(await db.routerAlert.count({ where: { operationId: operation.id, type: "OPERATION_STUCK" } })).toBe(1);
  });

  it("activates redeemed vouchers on the hotspot router", async () => {
    const { ctx, router } = await setup();
    const hs = await createPackage(ctx, packageInput.parse({ name: "Day Pass", serviceType: "HOTSPOT", price: "50.00", billingUnit: "DAY", billingCount: 1, networkProfile: "day-pass" }));
    const { codes } = await generateBatch(ctx, { packageId: hs.id, quantity: 1, codeLength: 10, routerId: router.id });
    const res = await redeemVoucher(ctx, { code: codes[0]!, mac: "AA:BB:CC:DD:EE:01" }, "staff");
    await drain();
    const user = fake.tables["/ip/hotspot/user"]!.find((u) => u.name === codes[0]);
    expect(user).toMatchObject({ profile: "day-pass", "mac-address": "AA:BB:CC:DD:EE:01" });
    expect(user!["limit-uptime"]).toMatch(/^(23h|1d)/);
    const redemption = await db.voucherRedemption.findUniqueOrThrow({ where: { id: res.redemptionId } });
    expect(redemption.activationStatus).toBe("ACTIVE");
    expect(await db.networkOperation.count({ where: { redemptionId: res.redemptionId, status: "SUCCEEDED", verification: "VERIFIED" } })).toBe(1);
  });

  it("mock adapter: results are labelled simulated and a flaky router is retried per policy", async () => {
    process.env.NETWORK_ADAPTER = "mock";
    const { ctx, subscription } = await setup();
    const lab = await createRouter(ctx, { name: "Lab [flaky]", host: "10.0.0.5", username: "x", password: "y" });
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: lab.id });
    await runOnce();
    expect((await getNetworkOperation(ctx, operation.id)).status).toBe("RETRYING");
    await drain();
    const op = await getNetworkOperation(ctx, operation.id);
    expect(op).toMatchObject({ status: "SIMULATED", verification: "NOT_SUPPORTED", attempts: 2 });
    expect(op.resultDetail).toMatch(/No router was changed/);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("SIMULATED_ACTIVE");
    expect(fake.log).toEqual([]); // the mock never opened a connection
  });
});

describe("network authorization and isolation", () => {
  it("only permitted staff can run router actions; other organizations see nothing", async () => {
    const { org, ctx, subscription, router } = await setup();
    const { operation } = await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    const cashier = await createStaff(org.organization.id, "cashier");
    const cashierCtx = await contextFor(cashier.user.id, org.organization.id);
    await expect(createRouter(cashierCtx, { name: "X", host: "10.0.0.9", username: "a", password: "b" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(provisionSubscriptionNetwork(cashierCtx, subscription.id, { routerId: router.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requestRouterOperation(cashierCtx, router.id, { type: "pppoe.sync", subscriptionId: subscription.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const res = await routerOperationRoute(
      request(`/api/v1/routers/${router.id}/operations`, { token: await sessionFor(cashier.user.id, org.organization.id), body: { type: "session.disconnect", kind: "PPPOE", username: "a000001" } }),
      { params: Promise.resolve({ id: router.id }) },
    );
    expect(res.status).toBe(403);
    // Arbitrary commands are not part of the contract.
    const ownerToken = await sessionFor(org.owner.id, org.organization.id);
    const raw = await routerOperationRoute(request(`/api/v1/routers/${router.id}/operations`, { token: ownerToken, body: { type: "/system/reboot" } }), { params: Promise.resolve({ id: router.id }) });
    expect(raw.status).toBe(400);

    const support = await createStaff(org.organization.id, "support");
    const supportCtx = await contextFor(support.user.id, org.organization.id);
    expect((await listNetworkOperations(supportCtx, { status: "ALL", page: 1, pageSize: 25 })).total).toBe(1);
    await expect(revealNetworkCredentials(supportCtx, subscription.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const other = await createOrg("Other ISP");
    const otherCtx = await contextFor(other.owner.id, other.organization.id);
    await expect(getRouter(otherCtx, router.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getNetworkOperation(otherCtx, operation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestRouterOperation(otherCtx, router.id, { type: "pppoe.sync", subscriptionId: subscription.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listNetworkOperations(otherCtx, { status: "ALL", page: 1, pageSize: 25 })).total).toBe(0);

    // Branch-restricted technician of another branch cannot see a router assigned to Main.
    const branch = await db.branch.create({ data: { organizationId: org.organization.id, name: "Westlands", code: "WST" } });
    const main = await db.branch.findFirstOrThrow({ where: { organizationId: org.organization.id, code: "MAIN" } });
    await updateRouter(ctx, router.id, { branchId: main.id });
    const tech = await createStaff(org.organization.id, "technician", { branchIds: [branch.id] });
    const techCtx = await contextFor(tech.user.id, org.organization.id);
    await expect(getRouter(techCtx, router.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getNetworkOperation(techCtx, operation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never stores revealed credentials in the idempotency table", async () => {
    const { org, ctx, subscription, router } = await setup();
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    const token = await sessionFor(org.owner.id, org.organization.id);
    const res = await revealRoute(
      request(`/api/v1/subscriptions/${subscription.id}/network/credentials`, { method: "POST", token, headers: { "idempotency-key": "reveal-key-0001" } }),
      { params: Promise.resolve({ id: subscription.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { data: { password: string } };
    expect(body.data.password).toHaveLength(12);
    expect(await db.idempotencyRecord.count({ where: { key: "reveal-key-0001" } })).toBe(0);
  });
});
