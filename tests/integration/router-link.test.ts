import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { archiveRouter, runRouterHealthChecks } from "@/server/services/routers";
import { createSetupCommand } from "@/server/services/router-setup";
import { getRouterLink, saveRouterServices, simulateRouter, startRouterLink } from "@/server/services/router-link";
import { GET as setupRoute } from "@/app/api/v1/routers/setup/[token]/route";
import { POST as checkInRoute } from "@/app/api/v1/routers/agent/[key]/route";
import { POST as resultRoute } from "@/app/api/v1/routers/agent/[key]/result/route";
import { PUT as servicesRoute } from "@/app/api/v1/routers/[id]/services/route";
import { ORIGIN, contextFor, createOrg, createStaff, request, sessionFor } from "./fixtures";

const KEYS = ["ROUTER_MANAGEMENT_SOURCES", "NETWORK_ADAPTER", "MIKROTIK_ALLOWED_NETWORKS", "APP_ENV", "ROUTER_AGENT_VERIFY_TLS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.ROUTER_MANAGEMENT_SOURCES = "10.8.0.1/32";
  process.env.NETWORK_ADAPTER = "routeros";
  delete process.env.MIKROTIK_ALLOWED_NETWORKS;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const REPORT = [
  "v=1",
  "identity=MikroTik",
  "version=7.16.2 (stable)",
  "board=hAP ax3",
  "uptime=2h3m",
  "if=ether1|ether|true",
  "if=ether2|ether|true",
  "if=ether3|ether|false",
  "if=ether4|ether|true",
  "if=wifi1|wifi|true",
  "if=bridge|bridge|true",
  "addr=192.168.88.1/24|bridge",
  "port=ether2|bridge",
  "port=ether3|bridge",
  "port=ether4|bridge",
  "port=wifi1|bridge",
  "dhcp=ether1|192.0.2.44/24",
].join("\n");

const tokenOf = (command: string) => /\/routers\/setup\/([A-Za-z0-9_-]+)"/.exec(command)![1]!;
const textRequest = (path: string, body: string, ip = "41.90.7.7") => new NextRequest(new URL(path, ORIGIN), { method: "POST", headers: { "content-type": "text/plain", "x-forwarded-for": ip }, body });
async function checkIn(key: string, body = REPORT) {
  const res = await checkInRoute(textRequest(`/api/v1/routers/agent/${key}`, body), { params: Promise.resolve({ key }) });
  return { status: res.status, body: await res.text(), headers: res.headers };
}
async function result(key: string, body: string) {
  const res = await resultRoute(textRequest(`/api/v1/routers/agent/${key}/result`, body), { params: Promise.resolve({ key }) });
  return { status: res.status, body: await res.text() };
}
const services = (patch: Record<string, unknown> = {}) => ({
  hotspot: true,
  pppoe: true,
  wanInterface: "ether1",
  ports: [
    { name: "ether2", use: "hotspot" as const },
    { name: "wifi1", use: "hotspot" as const },
    { name: "ether4", use: "pppoe" as const },
  ],
  devicesPerLogin: 2,
  blockSharing: true,
  ...patch,
});

/** Steps 1–2: name the router, generate the command, and let the "router" download the script. Returns the agent key. */
async function linkAndProvision(name: string) {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const router = await startRouterLink(ctx, { name });
  const cmd = await createSetupCommand(ctx, router.id);
  const res = await setupRoute(request(`/api/v1/routers/setup/${tokenOf(cmd.command)}`, { origin: null, headers: { "x-forwarded-for": "41.90.7.7" } }), { params: Promise.resolve({ token: tokenOf(cmd.command) }) });
  const script = await res.text();
  const key = /\/api\/v1\/routers\/agent\/([A-Za-z0-9_-]{40,})/.exec(script)![1]!;
  return { org, ctx, router, script, key };
}

describe("link a MikroTik", () => {
  it("names the router, installs the agent, records the first check-in and reports the ports", async () => {
    const { ctx, router, script, key } = await linkAndProvision("Westlands Tower");
    const created = await db.router.findUniqueOrThrow({ where: { id: router.id } });
    expect(created).toMatchObject({ host: null, linkedAt: null, hotspotEnabled: false, pppoeEnabled: false });
    expect(created.agentKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.agentKeyHash).not.toContain(key);
    expect(script).toContain('/system identity set name="Westlands Tower"');
    expect(script).toContain("/system scheduler add name=\"cloudlink-agent\" interval=1m");
    // Before the first check-in the router is "waiting", not offline.
    await runRouterHealthChecks(ctx.organizationId, router.id);
    expect((await db.router.findUniqueOrThrow({ where: { id: router.id } })).status).toBe("UNKNOWN");
    expect((await getRouterLink(ctx, router.id)).linkedAt).toBeNull();

    const first = await checkIn(key);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toMatch(/^# Cloudlink .*: nothing to change/);
    const state = await getRouterLink(ctx, router.id);
    expect(state).toMatchObject({ identity: "MikroTik", routerOsVersion: "7.16.2 (stable)", boardName: "hAP ax3", agentOnline: true, simulated: false, wanGuess: "ether1" });
    expect(state.linkedAt).not.toBeNull();
    expect(state.ports.map((p) => `${p.name}:${p.bridge ?? "-"}`)).toEqual(["ether1:-", "ether2:bridge", "ether3:bridge", "ether4:bridge", "wifi1:bridge"]);
    expect((await db.router.findUniqueOrThrow({ where: { id: router.id } })).status).toBe("ONLINE");
    expect(await db.auditLog.count({ where: { entityId: router.id, action: "router.link.connected" } })).toBe(1);

    expect((await checkIn("x".repeat(43))).status).toBe(404);
  });

  it("delivers the chosen services once, then records the router's confirmation", async () => {
    const { ctx, router, key } = await linkAndProvision("Kilimani");
    await expect(saveRouterServices(ctx, router.id, services())).rejects.toMatchObject({ code: "INVALID_STATE" });
    await checkIn(key);
    await expect(saveRouterServices(ctx, router.id, services({ ports: [{ name: "ether9", use: "hotspot" }, { name: "ether4", use: "pppoe" }] }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(saveRouterServices(ctx, router.id, services({ hotspotNetwork: "192.168.88.0/24" }))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Overlaps 192.168.88.1/24 on bridge" });

    const saved = await saveRouterServices(ctx, router.id, services());
    expect(saved.status).toBe("PENDING");
    expect(await db.router.findUniqueOrThrow({ where: { id: router.id } })).toMatchObject({ hotspotEnabled: true, pppoeEnabled: true, uplinkInterface: "ether1", hotspotDnsName: "wifi.login" });

    const delivered = await checkIn(key);
    expect(delivered.body).toContain(`# Change ${saved.changeId},`);
    expect(delivered.body).toContain('/interface bridge port add bridge="cloudlink-hotspot" interface="wifi1" comment="cloudlink"');
    expect(delivered.body).toContain("shared-users=2");
    expect(delivered.body).toContain(`/api/v1/routers/agent/${key}/result`);
    expect(await db.routerChange.findUniqueOrThrow({ where: { id: saved.changeId } })).toMatchObject({ status: "DELIVERED", deliveries: 1 });
    // Not sent again while the router is applying it.
    expect((await checkIn(key)).body).toMatch(/nothing to change/);
    expect((await getRouterLink(ctx, router.id)).change).toMatchObject({ id: saved.changeId, status: "DELIVERED" });

    expect((await result(key, `status=applied&change=${saved.changeId}`)).status).toBe(200);
    expect(await db.routerChange.findUniqueOrThrow({ where: { id: saved.changeId } })).toMatchObject({ status: "APPLIED" });
    expect((await getRouterLink(ctx, router.id)).services).toMatchObject({ hotspot: true, pppoe: true, devicesPerLogin: 2 });
    const actions = (await db.auditLog.findMany({ where: { entityId: router.id, action: { startsWith: "router.services" } } })).map((a) => a.action).sort();
    expect(actions).toEqual(["router.services.applied", "router.services.update"]);

    // A confirmation for another router's change, or a made-up one, changes nothing.
    expect((await result(key, "status=applied&change=0193f1c2-0000-7000-8000-000000000001")).status).toBe(200);
    expect((await result(key, "hello")).status).toBe(400);
  });

  it("marks a change failed when the router reports an error or never confirms it", async () => {
    const { ctx, router, key } = await linkAndProvision("Ruaka");
    await checkIn(key);
    const a = await saveRouterServices(ctx, router.id, services({ pppoe: false, ports: [{ name: "ether2", use: "hotspot" }] }));
    await checkIn(key);
    await result(key, "status=failed");
    expect(await db.routerChange.findUniqueOrThrow({ where: { id: a.changeId } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/router log/) });

    const b = await saveRouterServices(ctx, router.id, services({ pppoe: false, ports: [{ name: "ether2", use: "hotspot" }] }));
    for (let i = 1; i <= 3; i++) {
      expect((await checkIn(key)).body).toContain(`# Change ${b.changeId},`);
      await db.routerChange.update({ where: { id: b.changeId }, data: { deliveredAt: new Date(Date.now() - 3 * 60_000) } });
    }
    expect((await checkIn(key)).body).toMatch(/nothing to change/);
    expect(await db.routerChange.findUniqueOrThrow({ where: { id: b.changeId } })).toMatchObject({ status: "FAILED", deliveries: 3, error: expect.stringMatching(/did not confirm/) });

    // Saving again supersedes anything still pending.
    const c = await saveRouterServices(ctx, router.id, services({ pppoe: false, ports: [{ name: "ether2", use: "hotspot" }] }));
    const d = await saveRouterServices(ctx, router.id, services({ pppoe: false, ports: [{ name: "ether3", use: "hotspot" }] }));
    expect((await db.routerChange.findUniqueOrThrow({ where: { id: c.changeId } })).status).toBe("SUPERSEDED");
    expect((await getRouterLink(ctx, router.id)).change?.id).toBe(d.changeId);
  });

  it("judges health by check-ins, unlinks archived routers, and picks up a VPN address", async () => {
    process.env.MIKROTIK_ALLOWED_NETWORKS = "10.8.0.0/24";
    const { ctx, router, key } = await linkAndProvision("Thika Road");
    await checkIn(key, `${REPORT}\naddr=10.8.0.9/32|cloudlink-vpn\nif=cloudlink-vpn|wg|true`);
    const withHost = await db.router.findUniqueOrThrow({ where: { id: router.id } });
    expect(withHost.host).toBe("10.8.0.9");
    expect(await db.auditLog.count({ where: { entityId: router.id, action: "router.link.address" } })).toBe(1);

    // An agent-only router goes offline when check-ins stop, and back online with the next one.
    const { ctx: ctx2, router: r2, key: k2 } = await linkAndProvision("Juja");
    await checkIn(k2);
    await db.router.update({ where: { id: r2.id }, data: { agentLastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    await runRouterHealthChecks(ctx2.organizationId, r2.id);
    expect(await db.router.findUniqueOrThrow({ where: { id: r2.id } })).toMatchObject({ status: "OFFLINE", lastError: "No check-in from the router for 10 minutes" });
    expect(await db.routerAlert.count({ where: { routerId: r2.id, status: "OPEN", type: "ROUTER_OFFLINE" } })).toBe(1);
    await checkIn(k2);
    expect((await db.router.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("ONLINE");
    expect(await db.routerAlert.count({ where: { routerId: r2.id, status: "OPEN" } })).toBe(0);

    await archiveRouter(ctx2, r2.id);
    const bye = await checkIn(k2);
    expect(bye.body).toContain('/system scheduler remove [find name="cloudlink-agent"]');
    void ctx;
  });

  it("enforces permissions and organization scope", async () => {
    const { org, router, key } = await linkAndProvision("Embakasi");
    await checkIn(key);
    const cashier = await createStaff(org.organization.id, "cashier");
    const cashierCtx = await contextFor(cashier.user.id, org.organization.id);
    await expect(saveRouterServices(cashierCtx, router.id, services())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(startRouterLink(cashierCtx, { name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const res = await servicesRoute(request(`/api/v1/routers/${router.id}/services`, { method: "PUT", body: services(), token: await sessionFor(cashier.user.id, org.organization.id) }), { params: Promise.resolve({ id: router.id }) });
    expect(res.status).toBe(403);

    const other = await createOrg("Other ISP");
    const otherCtx = await contextFor(other.owner.id, other.organization.id);
    await expect(getRouterLink(otherCtx, router.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(saveRouterServices(otherCtx, router.id, services())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(simulateRouter(otherCtx, router.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("simulates a router in test mode only, labelled as simulated", async () => {
    process.env.NETWORK_ADAPTER = "mock";
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const router = await startRouterLink(ctx, { name: "Lab" });
    await expect(simulateRouter(ctx, router.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await createSetupCommand(ctx, router.id);
    expect(await simulateRouter(ctx, router.id)).toEqual({ simulated: true, appliedChange: null });
    const state = await getRouterLink(ctx, router.id);
    expect(state).toMatchObject({ simulated: true, agentOnline: true, canSimulate: true });
    expect(state.ports.map((p) => p.name)).toEqual(["ether1", "ether2", "ether3", "ether4", "ether5", "wlan1"]);
    const row = await db.router.findUniqueOrThrow({ where: { id: router.id } });
    expect(row).toMatchObject({ status: "UNKNOWN", lastSeenAt: null, identity: null });

    const saved = await saveRouterServices(ctx, router.id, services({ ports: [{ name: "ether2", use: "hotspot" }, { name: "ether5", use: "pppoe" }] }));
    expect(await simulateRouter(ctx, router.id)).toEqual({ simulated: true, appliedChange: saved.changeId });
    expect((await getRouterLink(ctx, router.id)).ports.find((p) => p.name === "ether2")?.bridge).toBeNull();
    expect(await db.routerChange.findUniqueOrThrow({ where: { id: saved.changeId } })).toMatchObject({ status: "APPLIED" });

    process.env.NETWORK_ADAPTER = "routeros";
    await expect(simulateRouter(ctx, router.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    process.env.NETWORK_ADAPTER = "mock";
    process.env.APP_ENV = "production";
    await expect(simulateRouter(ctx, router.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
