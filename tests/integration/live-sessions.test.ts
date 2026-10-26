import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage, packageInput } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { applySubscriptionAction } from "@/server/services/subscriptions";
import { createRouter } from "@/server/services/routers";
import { listNetworkSessions, provisionSubscriptionNetwork, requestSessionRefresh, sessionListQuery, syncNetworkSessions } from "@/server/services/network";
import { generateBatch, redeemVoucher } from "@/server/services/vouchers";
import { createPortalInviteLink, activatePortalAccount, portalLogin } from "@/server/portal/auth";
import { customerConnection } from "@/server/portal/services";
import { pruneRoutineOperations } from "@/server/jobs/scheduler";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { GET as connectionRoute } from "@/app/api/v1/customer/connection/route";
import type { CustomerContext } from "@/server/auth/context";
import { contextFor, createOrg, noParams, request } from "./fixtures";

let seq = 0;
const tel = () => `07${String(30_000_000 + seq++).padStart(8, "0")}`;
const meta = { correlationId: "live-sessions-01", ipAddress: "10.9.0.2", userAgent: "vitest" };
let savedAdapter: string | undefined;

beforeEach(() => {
  savedAdapter = process.env.NETWORK_ADAPTER;
  process.env.NETWORK_ADAPTER = "mock";
});
afterEach(() => {
  if (savedAdapter === undefined) delete process.env.NETWORK_ADAPTER;
  else process.env.NETWORK_ADAPTER = savedAdapter;
});

async function drain() {
  for (let i = 0; i < 10; i++) {
    const due = await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED"] }, type: { not: "network.sync_sessions" } }, orderBy: { createdAt: "asc" } });
    if (!due.length) return;
    for (const op of due) await runOperation(op.id, operationHandlers);
  }
}

async function setup(routerName = "Core-1") {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, packageInput.parse({ name: "Home 10", serviceType: "PPPOE", price: "2500.00", billingUnit: "MONTH", billingCount: 1, networkProfile: "home-10m" }));
  const { subscriber, subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Wanjiru", phone: tel(), packageId: pkg.id, activateSubscription: true }));
  const router = await createRouter(ctx, { name: routerName, host: "10.20.0.1", apiPort: 8728, username: "cloudlink", password: "router-pass", hotspotEnabled: true });
  return { org, ctx, subscriber, subscription: subscription!, router };
}

function customerCtx(organizationId: string, subscriberId: string): CustomerContext {
  return { kind: "customer", organizationId, subscriberId } as CustomerContext;
}

describe("live sessions", () => {
  it("simulates sessions in test mode only for lines Cloudlink enabled, and closes them when access is removed", async () => {
    const { org, ctx, subscriber, subscription, router } = await setup();
    const cctx = customerCtx(org.organization.id, subscriber.id);

    // Not provisioned yet: nothing to simulate, and the portal hides the card.
    expect(await syncNetworkSessions(org.organization.id)).toEqual({ routers: 1, sessions: 0, failed: 0 });
    expect((await customerConnection(cctx)).status).toBe("NOT_SET_UP");

    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("SIMULATED_ACTIVE");
    expect(await syncNetworkSessions(org.organization.id)).toEqual({ routers: 1, sessions: 1, failed: 0 });
    // A sync only counts once its background operation succeeds; record one as the worker would.
    await db.backgroundOperation.create({ data: { organizationId: org.organization.id, type: "network.sync_sessions", status: "SUCCEEDED", payload: {}, finishedAt: new Date() } });

    const list = await listNetworkSessions(ctx, sessionListQuery.parse({}));
    expect(list.online).toEqual({ pppoe: 1, hotspot: 0 });
    expect(list.rows).toEqual([expect.objectContaining({ kind: "PPPOE", subscriberId: subscriber.id, source: "mock", endedAt: null })]);
    expect(list.rows[0]!.address).toMatch(/^10\./);
    expect(list.lastSyncedAt).toBeInstanceOf(Date);

    const online = await customerConnection(cctx);
    expect(online).toMatchObject({ status: "ONLINE", connections: 1, simulated: true, stale: false, lastOnlineAt: null });
    expect(online.since).toBeInstanceOf(Date);
    expect(BigInt(online.downloadedBytes ?? "0")).toBeGreaterThanOrEqual(0n);

    // Re-syncing keeps the same session open (no duplicates).
    await syncNetworkSessions(org.organization.id);
    expect(await db.networkSession.count({ where: { routerId: router.id, endedAt: null } })).toBe(1);

    // Suspension disables the line on the (mock) router; the next sync ends the session.
    await applySubscriptionAction(ctx, subscription.id, "suspend", { reason: "Unpaid" });
    await drain();
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).networkStatus).toBe("SIMULATED_DISABLED");
    await syncNetworkSessions(org.organization.id);
    const offline = await customerConnection(cctx);
    expect(offline).toMatchObject({ status: "OFFLINE", connections: 0, simulated: false });
    expect(offline.lastOnlineAt).toBeInstanceOf(Date);
    expect((await listNetworkSessions(ctx, sessionListQuery.parse({}))).online).toEqual({ pppoe: 0, hotspot: 0 });
  });

  it("simulates hotspot sessions for active vouchers without storing the voucher code", async () => {
    const { org, ctx, router } = await setup();
    const hs = await createPackage(ctx, packageInput.parse({ name: "Day Pass", serviceType: "HOTSPOT", price: "50.00", billingUnit: "DAY", billingCount: 1, networkProfile: "day-pass" }));
    const { codes } = await generateBatch(ctx, { packageId: hs.id, quantity: 1, codeLength: 10, routerId: router.id });
    await redeemVoucher(ctx, { code: codes[0]!, mac: "AA:BB:CC:DD:EE:07" }, "staff");
    await drain();
    await syncNetworkSessions(org.organization.id);
    const [s] = await db.networkSession.findMany({ where: { routerId: router.id, kind: "HOTSPOT" } });
    expect(s).toMatchObject({ source: "mock", macAddress: "AA:BB:CC:DD:EE:07", endedAt: null });
    expect(s!.username).toMatch(/^voucher …/);
    expect(s!.username).not.toContain(codes[0]!.slice(0, 6));
  });

  it("keeps sessions open when a router cannot be read, and reports the data as stale to customers", async () => {
    const { org, ctx, subscriber, subscription, router } = await setup();
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    await syncNetworkSessions(org.organization.id);
    await db.router.update({ where: { id: router.id }, data: { name: "Core-1 [offline]" } });
    expect(await syncNetworkSessions(org.organization.id)).toEqual({ routers: 1, sessions: 0, failed: 1 });
    expect(await db.networkSession.count({ where: { routerId: router.id, endedAt: null } })).toBe(1);

    // Twenty minutes without a successful sync: still "online" per the last reading, but flagged stale.
    await db.networkSession.updateMany({ where: { routerId: router.id }, data: { lastSeenAt: new Date(Date.now() - 20 * 60_000) } });
    expect(await customerConnection(customerCtx(org.organization.id, subscriber.id))).toMatchObject({ status: "ONLINE", stale: true });
  });

  it("scopes a customer's connection to their own line and serves it only to signed-in customers", async () => {
    const { org, ctx, subscription, router } = await setup();
    await provisionSubscriptionNetwork(ctx, subscription.id, { routerId: router.id });
    await drain();
    await syncNetworkSessions(org.organization.id);

    const { subscriber: other } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Otieno", phone: tel() }));
    expect((await customerConnection(customerCtx(org.organization.id, other.id))).status).toBe("NOT_SET_UP");

    const { link } = await createPortalInviteLink(ctx, other.id);
    await activatePortalAccount({ token: new URL(link).searchParams.get("token")!, password: "Portal-Pass-123" }, meta);
    const { token } = await portalLogin({ organization: org.organization.slug, identifier: other.phone, password: "Portal-Pass-123" }, meta);
    const res = await connectionRoute(request("/api/v1/customer/connection", { portalToken: token }), noParams);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "NOT_SET_UP", connections: 0, address: null });
    expect((await connectionRoute(request("/api/v1/customer/connection"), noParams)).status).toBe(401);
  });

  it("de-duplicates live refresh requests and prunes old routine operations", async () => {
    const { org, ctx } = await setup();
    const a = await requestSessionRefresh(ctx);
    const b = await requestSessionRefresh(ctx);
    // Same 30-second bucket → same operation (unless the test straddles a bucket boundary).
    if (Math.floor(Date.now() / 30_000) === Math.floor((Date.now() - 50) / 30_000)) expect(b.operationId).toBe(a.operationId);

    const old = new Date(Date.now() - 20 * 86_400_000);
    const mk = (type: string, status: "SUCCEEDED" | "DEAD", finishedAt: Date) => db.backgroundOperation.create({ data: { organizationId: org.organization.id, type, status, payload: {}, finishedAt } });
    const oldSync = await mk("network.sync_sessions", "SUCCEEDED", old);
    const oldHealth = await mk("routers.healthcheck", "SUCCEEDED", old);
    const deadSync = await mk("network.sync_sessions", "DEAD", old);
    const recentSync = await mk("network.sync_sessions", "SUCCEEDED", new Date());
    const oldBilling = await mk("billing.run_recurring", "SUCCEEDED", old);
    const otherOrg = await createOrg("Other ISP");
    const foreign = await db.backgroundOperation.create({ data: { organizationId: otherOrg.organization.id, type: "network.sync_sessions", status: "SUCCEEDED", payload: {}, finishedAt: old } });

    expect(await pruneRoutineOperations(org.organization.id)).toEqual({ deleted: 2 });
    const left = new Set((await db.backgroundOperation.findMany({ where: { id: { in: [oldSync.id, oldHealth.id, deadSync.id, recentSync.id, oldBilling.id, foreign.id] } }, select: { id: true } })).map((o) => o.id));
    expect(left).toEqual(new Set([deadSync.id, recentSync.id, oldBilling.id, foreign.id]));
  });
});
