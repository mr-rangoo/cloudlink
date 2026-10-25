import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createRouter, routerTarget } from "@/server/services/routers";
import { createSetupCommand } from "@/server/services/router-setup";
import { GET as setupRoute } from "@/app/api/v1/routers/setup/[token]/route";
import { POST as setupCommandRoute } from "@/app/api/v1/routers/[id]/setup-command/route";
import { contextFor, createOrg, createStaff, request, sessionFor } from "./fixtures";

const KEYS = ["ROUTER_MANAGEMENT_SOURCES", "RADIUS_SERVER_ADDRESS", "RADIUS_SHARED_SECRET", "NETWORK_ADAPTER"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.ROUTER_MANAGEMENT_SOURCES = "10.8.0.1/32";
  process.env.NETWORK_ADAPTER = "routeros";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const tokenOf = (command: string) => /\/routers\/setup\/([A-Za-z0-9_-]+)"/.exec(command)![1]!;
async function fetchScript(token: string, ip = "41.90.7.7") {
  const res = await setupRoute(request(`/api/v1/routers/setup/${token}`, { origin: null, headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token }) });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("router setup command", () => {
  it("serves a single-use script once, rotates the API credentials and schedules a health check", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const router = await createRouter(ctx, { name: "Core-1", host: "10.8.0.20", username: "old-user", password: "old-password", pppoeAuth: "RADIUS", hotspotEnabled: true });
    process.env.RADIUS_SERVER_ADDRESS = "10.8.0.5";
    process.env.RADIUS_SHARED_SECRET = "radius-shared-secret";

    const cmd = await createSetupCommand(ctx, router.id);
    expect(cmd.command).toMatch(/^\/tool fetch mode=http url="http:\/\/localhost:3100\/api\/v1\/routers\/setup\/[A-Za-z0-9_-]{40,}" dst-path=cloudlink-setup\.rsc; :delay 2s; \/import file-name=cloudlink-setup\.rsc;$/);
    expect(cmd.warnings.join(" ")).toMatch(/not HTTPS/);
    const token = tokenOf(cmd.command);
    expect((await db.router.findUniqueOrThrow({ where: { id: router.id } })).setupTokenHash).not.toContain(token);

    const first = await fetchScript(token);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("content-type")).toMatch(/^text\/plain/);
    const target = await routerTarget({ id: router.id, name: router.name, host: router.host, apiPort: router.apiPort, useTls: router.useTls });
    expect(target.username).toBe("cloudlink-api");
    expect(target.password).toMatch(/^[A-Za-z2-9]{24}$/);
    expect(first.body).toContain(`password="${target.password}" address="10.8.0.1/32"`);
    expect(first.body).toContain(`/radius add service=ppp address=10.8.0.5 secret="radius-shared-secret"`);
    expect(first.body).toContain(`walled-garden add dst-host="localhost"`);

    const again = await fetchScript(token);
    expect(again.status).toBe(404);
    expect(again.body).not.toContain(target.password);

    const r = await db.router.findUniqueOrThrow({ where: { id: router.id } });
    expect(r).toMatchObject({ setupTokenHash: null, onboardedFromIp: "41.90.7.7" });
    expect(await db.backgroundOperation.count({ where: { type: "routers.healthcheck", payload: { path: ["routerId"], equals: router.id } } })).toBe(1);
    const auditRows = await db.auditLog.findMany({ where: { entityId: router.id, action: { startsWith: "router.setup_command" } } });
    expect(auditRows.map((a) => a.action).sort()).toEqual(["router.setup_command.create", "router.setup_command.used"]);
    expect(JSON.stringify(auditRows)).not.toContain(target.password);
  });

  it("expires, is replaced by a newer command, refuses archived routers and requires routers.write", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const router = await createRouter(ctx, { name: "Edge", host: "10.8.0.21", username: "a", password: "b" });

    const old = tokenOf((await createSetupCommand(ctx, router.id)).command);
    const fresh = tokenOf((await createSetupCommand(ctx, router.id)).command);
    expect((await fetchScript(old)).status).toBe(404);

    await db.router.update({ where: { id: router.id }, data: { setupExpiresAt: new Date(Date.now() - 1000) } });
    expect((await fetchScript(fresh)).status).toBe(404);
    expect((await fetchScript("x".repeat(43))).status).toBe(404);

    const cashier = await createStaff(org.organization.id, "cashier");
    const cashierCtx = await contextFor(cashier.user.id, org.organization.id);
    await expect(createSetupCommand(cashierCtx, router.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const res = await setupCommandRoute(request(`/api/v1/routers/${router.id}/setup-command`, { method: "POST", token: await sessionFor(cashier.user.id, org.organization.id) }), { params: Promise.resolve({ id: router.id }) });
    expect(res.status).toBe(403);

    const other = await createOrg("Other ISP");
    await expect(createSetupCommand(await contextFor(other.owner.id, other.organization.id), router.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The command response is a secret: never stored for idempotent replay.
    const ownerRes = await setupCommandRoute(request(`/api/v1/routers/${router.id}/setup-command`, { method: "POST", token: await sessionFor(org.owner.id, org.organization.id), headers: { "idempotency-key": "setup-key-0001" } }), { params: Promise.resolve({ id: router.id }) });
    expect(ownerRes.status).toBe(200);
    expect(await db.idempotencyRecord.count({ where: { key: "setup-key-0001" } })).toBe(0);

    const live = tokenOf(((await ownerRes.json()) as { data: { command: string } }).data.command);
    await db.router.update({ where: { id: router.id }, data: { archivedAt: new Date() } });
    expect((await fetchScript(live)).status).toBe(404);
  });
});
