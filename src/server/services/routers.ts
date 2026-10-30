import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { listWhere, requirePermission, resolveBranchForCreate, assertBranchAccess, tenantWhere, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import { checkRouterHost } from "@/server/domain/network-address";
import { networkAdapter, networkAdapterName, type RouterHealth, type RouterTarget } from "@/server/integrations/network";
import { dispatchOperation, enqueueOperation, PermanentError } from "@/server/jobs/operations";
import { searchTerm } from "@/server/services/common";
import { availability, healthScore, type TelemetrySample } from "@/server/domain/router-telemetry";
import { logger } from "@/server/observability/logger";
import type { Prisma, Router } from "@/generated/prisma/client";

/**
 * Router inventory. Credentials are encrypted with AES-256-GCM bound to the router id (AAD `router:<id>`),
 * are write-only through the API, and are decrypted only inside the worker when an operation runs.
 * Management addresses must be private/VPN IPs (see domain/network-address.ts).
 */

const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);

const routerFields = {
  name: z.string().trim().min(2).max(80),
  host: z.string().trim().min(2).max(64),
  apiPort: z.coerce.number().int().min(1).max(65535),
  useTls: z.boolean(),
  pppoeAuth: z.enum(["LOCAL", "RADIUS"]),
  pppoeEnabled: z.boolean(),
  hotspotEnabled: z.boolean(),
  branchId: z.uuid().nullable(),
  notes: z.string().trim().max(500).nullable(),
  /** DNS name of the router's hotspot login page; the captive portal posts logins only there or to a private IP. */
  hotspotDnsName: z
    .union([
      z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, "Enter a host name such as wifi.login"),
      z.literal("").transform(() => null),
    ])
    .nullable(),
  /** Interface whose traffic is charted; empty = the first running Ethernet port. */
  uplinkInterface: z.union([z.string().trim().regex(/^[A-Za-z0-9._<>/-]{1,64}$/, "Enter an interface name such as ether1"), z.literal("").transform(() => null)]).nullable(),
  maintenanceMode: z.boolean(),
  maintenanceNote: z.string().trim().max(200).nullable(),
};

const apiUsername = z.string().trim().min(1).max(64).refine(noControl, "Invalid characters").refine((v) => !/\s/.test(v), "Must not contain spaces");
const apiPassword = z.string().min(1).max(128).refine(noControl, "Invalid characters");

export const routerInput = z.object({
  name: routerFields.name,
  host: routerFields.host,
  apiPort: routerFields.apiPort.default(8728),
  useTls: routerFields.useTls.default(false),
  pppoeAuth: routerFields.pppoeAuth.default("LOCAL"),
  pppoeEnabled: routerFields.pppoeEnabled.default(true),
  hotspotEnabled: routerFields.hotspotEnabled.default(false),
  branchId: routerFields.branchId.optional(),
  notes: routerFields.notes.optional(),
  hotspotDnsName: routerFields.hotspotDnsName.optional(),
  username: apiUsername,
  password: apiPassword,
});

export const routerUpdateInput = z
  .object({
    name: routerFields.name.optional(),
    host: routerFields.host.optional(),
    apiPort: routerFields.apiPort.optional(),
    useTls: routerFields.useTls.optional(),
    pppoeAuth: routerFields.pppoeAuth.optional(),
    pppoeEnabled: routerFields.pppoeEnabled.optional(),
    hotspotEnabled: routerFields.hotspotEnabled.optional(),
    branchId: routerFields.branchId.optional(),
    notes: routerFields.notes.optional(),
    hotspotDnsName: routerFields.hotspotDnsName.optional(),
    uplinkInterface: routerFields.uplinkInterface.optional(),
    maintenanceMode: routerFields.maintenanceMode.optional(),
    maintenanceNote: routerFields.maintenanceNote.optional(),
    username: apiUsername.optional(),
    password: apiPassword.optional(),
  })
  .refine((v) => (v.username === undefined) === (v.password === undefined), { message: "Provide both the API username and password to replace credentials", path: ["password"] });

export const routerListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["ONLINE", "OFFLINE", "UNKNOWN", "ERROR", "ALL"]).default("ALL"),
  archived: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const alertListQuery = z.object({
  status: z.enum(["OPEN", "RESOLVED", "ALL"]).default("OPEN"),
  routerId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const routerPublicSelect = {
  id: true,
  name: true,
  host: true,
  apiPort: true,
  useTls: true,
  pppoeAuth: true,
  pppoeEnabled: true,
  hotspotEnabled: true,
  hotspotDnsName: true,
  uplinkInterface: true,
  maintenanceMode: true,
  maintenanceNote: true,
  status: true,
  identity: true,
  routerOsVersion: true,
  boardName: true,
  lastSeenAt: true,
  lastCheckedAt: true,
  lastError: true,
  notes: true,
  branchId: true,
  archivedAt: true,
  setupExpiresAt: true,
  onboardedAt: true,
  onboardedFromIp: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RouterSelect;

// ───────── Address policy ─────────

export function routerHostPolicy(host: string) {
  return checkRouterHost(host, { allowedNetworks: process.env.MIKROTIK_ALLOWED_NETWORKS ?? "", allowLoopback: (process.env.APP_ENV ?? "development") !== "production" });
}

function assertConnectionPolicy(host: string, useTls: boolean) {
  const check = routerHostPolicy(host);
  if (!check.ok) throw new AppError("VALIDATION_ERROR", check.reason, { fields: [{ path: "host", message: check.reason }] });
  if (process.env.MIKROTIK_CONNECTION_MODE === "api-ssl" && !useTls) {
    const message = "This deployment requires the TLS API (api-ssl, usually port 8729).";
    throw new AppError("VALIDATION_ERROR", message, { fields: [{ path: "useTls", message }] });
  }
}

const credentialAad = (routerId: string) => `router:${routerId}`;

function sealCredentials(routerId: string, username: string, password: string): string {
  return encryptSecret(JSON.stringify({ username, password }), credentialAad(routerId));
}

/** Replace a router's stored API credentials (encrypted, bound to the router id). */
export async function storeRouterCredentials(routerId: string, username: string, password: string, updatedById: string | null) {
  const encryptedSecret = sealCredentials(routerId, username, password);
  await db.routerCredential.upsert({ where: { routerId }, update: { encryptedSecret, updatedById }, create: { routerId, encryptedSecret, updatedById } });
}

/** Worker-side only: build the connection target with decrypted credentials. Never return this to clients. */
export async function routerTarget(router: Pick<Router, "id" | "name" | "host" | "apiPort" | "useTls">): Promise<RouterTarget> {
  const cred = await db.routerCredential.findUnique({ where: { routerId: router.id } });
  if (!cred) throw new PermanentError("Router has no stored API credentials", "ROUTER_NO_CREDENTIALS");
  let parsed: { username: string; password: string };
  try {
    parsed = JSON.parse(decryptSecret(cred.encryptedSecret, credentialAad(router.id)));
  } catch {
    throw new PermanentError("Router credentials could not be decrypted (wrong APP_ENCRYPTION_KEY?)", "ROUTER_CREDENTIALS_UNREADABLE");
  }
  return { id: router.id, name: router.name, host: router.host, apiPort: router.apiPort, useTls: router.useTls, username: parsed.username, password: parsed.password };
}

/** Policy checks repeated at execution time (defence in depth: env or router may have changed since creation). */
export function assertExecutable(router: Pick<Router, "host" | "useTls" | "archivedAt">) {
  if (router.archivedAt) throw new PermanentError("Router is archived", "ROUTER_ARCHIVED");
  const check = routerHostPolicy(router.host);
  if (!check.ok) throw new PermanentError(check.reason, "ROUTER_ADDRESS_REFUSED");
  if (process.env.MIKROTIK_CONNECTION_MODE === "api-ssl" && !router.useTls) throw new PermanentError("TLS API required by MIKROTIK_CONNECTION_MODE=api-ssl", "ROUTER_TLS_REQUIRED");
}

// ───────── CRUD ─────────

function uniqueNameError(err: unknown): never {
  if ((err as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "A router with this name already exists.", { fields: [{ path: "name", message: "Already in use" }] });
  throw err;
}

export async function createRouter(ctx: StaffContext, raw: z.input<typeof routerInput>) {
  requirePermission(ctx, "routers.write");
  const input = routerInput.parse(raw);
  assertConnectionPolicy(input.host, input.useTls);
  const branchId = await resolveBranchForCreate(ctx, input.branchId);
  const router = await db
    .$transaction(async (tx) => {
      const r = await tx.router.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          name: input.name,
          host: input.host,
          apiPort: input.apiPort,
          useTls: input.useTls,
          pppoeAuth: input.pppoeAuth,
          pppoeEnabled: input.pppoeEnabled,
          hotspotEnabled: input.hotspotEnabled,
          hotspotDnsName: input.hotspotDnsName ?? null,
          notes: input.notes ?? null,
        },
        select: routerPublicSelect,
      });
      await tx.routerCredential.create({ data: { routerId: r.id, encryptedSecret: sealCredentials(r.id, input.username, input.password), updatedById: ctx.userId } });
      return r;
    })
    .catch(uniqueNameError);
  await audit(ctx, { action: "router.create", entityType: "router", entityId: router.id, metadata: { name: router.name, host: router.host, apiPort: router.apiPort, useTls: router.useTls, pppoeAuth: router.pppoeAuth } });
  return router;
}

async function findRouter(ctx: StaffContext, id: string) {
  const router = await db.router.findFirst({ where: { id, ...tenantWhere(ctx) }, select: routerPublicSelect });
  if (!router) throw notFound("router");
  return router;
}

export async function updateRouter(ctx: StaffContext, id: string, raw: z.input<typeof routerUpdateInput>) {
  requirePermission(ctx, "routers.write");
  const input = routerUpdateInput.parse(raw);
  const current = await findRouter(ctx, id);
  if (current.archivedAt) throw new AppError("INVALID_STATE", "Archived routers cannot be edited.");
  const host = input.host ?? current.host;
  const useTls = input.useTls ?? current.useTls;
  if (input.host !== undefined || input.useTls !== undefined) assertConnectionPolicy(host, useTls);
  if (input.branchId !== undefined) await assertBranchAccess(ctx, input.branchId);
  const data: Prisma.RouterUpdateInput = {};
  for (const key of ["name", "host", "apiPort", "useTls", "pppoeAuth", "pppoeEnabled", "hotspotEnabled", "hotspotDnsName", "uplinkInterface", "maintenanceMode", "maintenanceNote", "branchId", "notes"] as const) {
    if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
  }
  const rotated = input.username !== undefined && input.password !== undefined;
  const router = await db
    .$transaction(async (tx) => {
      const r = await tx.router.update({ where: { id }, data, select: routerPublicSelect });
      if (rotated) {
        const encryptedSecret = sealCredentials(id, input.username!, input.password!);
        await tx.routerCredential.upsert({ where: { routerId: id }, update: { encryptedSecret, updatedById: ctx.userId }, create: { routerId: id, encryptedSecret, updatedById: ctx.userId } });
      }
      return r;
    })
    .catch(uniqueNameError);
  const changed = Object.keys(data);
  await audit(ctx, { action: "router.update", entityType: "router", entityId: id, metadata: { changed, credentialsRotated: rotated } });
  return router;
}

export async function archiveRouter(ctx: StaffContext, id: string) {
  requirePermission(ctx, "routers.write");
  const router = await findRouter(ctx, id);
  if (router.archivedAt) return router;
  const provisioned = await db.subscription.count({ where: { organizationId: ctx.organizationId, networkRouterId: id } });
  if (provisioned) throw new AppError("INVALID_STATE", `${provisioned} subscription(s) are provisioned on this router. Move or remove their network access first.`);
  const updated = await db.router.update({ where: { id }, data: { archivedAt: new Date() }, select: routerPublicSelect });
  await audit(ctx, { action: "router.archive", entityType: "router", entityId: id, metadata: { name: router.name } });
  return updated;
}

export async function listRouters(ctx: StaffContext, query: z.infer<typeof routerListQuery>) {
  requirePermission(ctx, "routers.read");
  const q = searchTerm(query.q);
  const where: Prisma.RouterWhereInput = {
    ...listWhere(ctx),
    archivedAt: query.archived === "true" ? { not: null } : null,
    ...(query.status !== "ALL" ? { status: query.status } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { host: { contains: q } }, { identity: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.router.findMany({ where, select: routerPublicSelect, orderBy: { name: "asc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.router.count({ where }),
  ]);
  const ids = rows.map((r) => r.id);
  const [subs, sessions, alerts, branches] = await Promise.all([
    db.subscription.groupBy({ by: ["networkRouterId"], where: { organizationId: ctx.organizationId, networkRouterId: { in: ids } }, _count: { _all: true } }),
    db.networkSession.groupBy({ by: ["routerId"], where: { organizationId: ctx.organizationId, routerId: { in: ids }, endedAt: null }, _count: { _all: true } }),
    db.routerAlert.groupBy({ by: ["routerId"], where: { organizationId: ctx.organizationId, routerId: { in: ids }, status: "OPEN" }, _count: { _all: true } }),
    db.branch.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
  ]);
  const count = <T extends { _count: { _all: number } }>(list: T[], key: (t: T) => string | null, id: string) => list.find((x) => key(x) === id)?._count._all ?? 0;
  const now = new Date();
  const [samples, byStatus, maintenance] = await Promise.all([
    db.routerMetricSample.findMany({
      where: { organizationId: ctx.organizationId, routerId: { in: ids }, takenAt: { gte: new Date(now.getTime() - 86_400_000) } },
      select: { routerId: true, takenAt: true, reachable: true, simulated: true, responseMs: true, cpuLoad: true, memoryUsedPct: true, diskUsedPct: true, uptimeSeconds: true },
      orderBy: { takenAt: "asc" },
    }),
    db.router.groupBy({ by: ["status"], where: { ...listWhere(ctx), archivedAt: null }, _count: { _all: true } }),
    db.router.count({ where: { ...listWhere(ctx), archivedAt: null, maintenanceMode: true } }),
  ]);
  const telemetry = (id: string) => {
    const mine: TelemetrySample[] = samples
      .filter((x) => x.routerId === id)
      .map((x) => ({ ...x, temperatureC: null, rxBps: null, txBps: null, sessions: null }));
    const latestUp = [...mine].reverse().find((x) => x.reachable);
    return {
      health: healthScore(mine, now),
      availability24h: availability(mine),
      latest: latestUp ? { cpuLoad: latestUp.cpuLoad, memoryUsedPct: latestUp.memoryUsedPct, uptimeSeconds: latestUp.uptimeSeconds, simulated: latestUp.simulated } : null,
    };
  };
  const statusCount = (st: string) => byStatus.find((b) => b.status === st)?._count._all ?? 0;
  return {
    rows: rows.map((r) => ({
      ...r,
      branchName: branches.find((b) => b.id === r.branchId)?.name ?? null,
      provisionedSubscriptions: count(subs, (s) => s.networkRouterId, r.id),
      activeSessions: count(sessions, (s) => s.routerId, r.id),
      openAlerts: count(alerts, (a) => a.routerId, r.id),
      ...telemetry(r.id),
    })),
    total,
    summary: {
      total: byStatus.reduce((a, b) => a + b._count._all, 0),
      online: statusCount("ONLINE"),
      offline: statusCount("OFFLINE") + statusCount("ERROR"),
      unknown: statusCount("UNKNOWN"),
      maintenance,
    },
    adapter: networkAdapterName(),
  };
}

/** Router names for list filters (no addresses). */
export async function routerNameOptions(ctx: StaffContext) {
  requirePermission(ctx, "routers.read");
  return db.router.findMany({ where: { ...tenantWhere(ctx), archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** Routers the caller may provision onto (for pickers). */
export async function routerOptions(ctx: StaffContext, purpose: "pppoe" | "hotspot") {
  requirePermission(ctx, "routers.read");
  return db.router.findMany({
    where: { ...tenantWhere(ctx), archivedAt: null, ...(purpose === "pppoe" ? { pppoeEnabled: true } : { hotspotEnabled: true }) },
    select: { id: true, name: true, host: true, pppoeAuth: true, status: true },
    orderBy: { name: "asc" },
  });
}

export async function getRouter(ctx: StaffContext, id: string) {
  requirePermission(ctx, "routers.read");
  const router = await findRouter(ctx, id);
  const [credential, branch, provisioned, openAlerts, activeSessions] = await Promise.all([
    db.routerCredential.findUnique({ where: { routerId: id }, select: { updatedAt: true } }),
    router.branchId ? db.branch.findUnique({ where: { id: router.branchId }, select: { name: true } }) : null,
    db.subscription.count({ where: { organizationId: ctx.organizationId, networkRouterId: id } }),
    db.routerAlert.count({ where: { organizationId: ctx.organizationId, routerId: id, status: "OPEN" } }),
    db.networkSession.count({ where: { organizationId: ctx.organizationId, routerId: id, endedAt: null } }),
  ]);
  return { ...router, branchName: branch?.name ?? null, credentialsUpdatedAt: credential?.updatedAt ?? null, provisionedSubscriptions: provisioned, openAlerts, activeSessions, adapter: networkAdapterName() };
}

/** Queue a health check for one router (all router I/O happens in the worker). */
export async function requestHealthCheck(ctx: StaffContext, id: string) {
  requirePermission(ctx, "network.operate");
  const router = await findRouter(ctx, id);
  if (router.archivedAt) throw new AppError("INVALID_STATE", "Archived routers are not checked.");
  const bucket = Math.floor(Date.now() / 10_000); // at most one manual check per router every 10 seconds
  const op = await enqueueOperation({ type: "routers.healthcheck", organizationId: ctx.organizationId, payload: { routerId: id }, dedupeKey: `routers.healthcheck:${id}:manual:${bucket}`, maxAttempts: 1, correlationId: ctx.correlationId });
  await dispatchOperation(op);
  await audit(ctx, { action: "router.health_check", entityType: "router", entityId: id });
  return { queued: true, operationId: op.id };
}

// ───────── Health checks (worker) ─────────

async function openAlert(organizationId: string, data: { routerId?: string | null; operationId?: string | null; type: string; severity: "warning" | "critical"; message: string }) {
  const existing = await db.routerAlert.findFirst({
    where: { organizationId, type: data.type, status: "OPEN", ...(data.operationId ? { operationId: data.operationId } : { routerId: data.routerId ?? null }) },
  });
  if (existing) return existing;
  return db.routerAlert.create({ data: { organizationId, routerId: data.routerId ?? null, operationId: data.operationId ?? null, type: data.type, severity: data.severity, message: data.message } });
}
export { openAlert };

const pct = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.min(100, Math.max(0, Math.round(v))));
const nonNegative = (v: bigint | undefined) => (v === undefined || v < BigInt(0) ? null : v);

/** One telemetry row per check (charts, health score, reachability heatmap). */
function sampleOf(router: Router, health: RouterHealth, responseMs: number, sessions: number, takenAt: Date): Prisma.RouterMetricSampleCreateManyInput {
  const m = health.online ? (health.metrics ?? {}) : {};
  return {
    organizationId: router.organizationId,
    routerId: router.id,
    takenAt,
    reachable: health.online,
    simulated: Boolean(health.simulated),
    responseMs: health.online ? Math.max(0, Math.round(responseMs)) : null,
    cpuLoad: pct(m.cpuLoad),
    memoryUsedPct: pct(m.memoryUsedPct),
    diskUsedPct: pct(m.diskUsedPct),
    temperatureC: m.temperatureC !== undefined && Math.abs(m.temperatureC) < 1000 ? m.temperatureC.toFixed(1) : null,
    uptimeSeconds: m.uptimeSeconds !== undefined && m.uptimeSeconds >= 0 ? Math.min(m.uptimeSeconds, 2_147_483_647) : null,
    rxBps: nonNegative(m.rxBps),
    txBps: nonNegative(m.txBps),
    sessions: health.online ? sessions : null,
  };
}

/**
 * Check one router or every active router of an organization: records status and a telemetry sample, and raises or
 * resolves offline alerts (not while the router is in maintenance mode).
 */
export async function runRouterHealthChecks(organizationId: string, routerId?: string) {
  const routers = await db.router.findMany({ where: { organizationId, archivedAt: null, ...(routerId ? { id: routerId } : {}) } });
  const adapter = networkAdapter();
  let online = 0;
  for (const router of routers) {
    const now = new Date();
    let health: RouterHealth;
    const started = Date.now();
    try {
      assertExecutable(router);
      health = await adapter.health(await routerTarget(router), { uplinkInterface: router.uplinkInterface });
    } catch (err) {
      health = { online: false, detail: err instanceof Error ? err.message : "Health check failed" };
    }
    const responseMs = Date.now() - started;
    if (health.online) online++;
    if (adapter.name !== "disabled") {
      const sessions = await db.networkSession.count({ where: { organizationId, routerId: router.id, endedAt: null } });
      await db.routerMetricSample.createMany({ data: [sampleOf(router, health, responseMs, sessions, now)] });
    }
    const status = health.simulated && health.online ? "UNKNOWN" : health.online ? "ONLINE" : "OFFLINE";
    await db.router.update({
      where: { id: router.id },
      data: {
        status,
        lastCheckedAt: now,
        lastError: health.online ? null : health.detail.slice(0, 300),
        ...(health.online && !health.simulated ? { lastSeenAt: now, identity: health.identity ?? router.identity, routerOsVersion: health.version ?? router.routerOsVersion, boardName: health.board ?? router.boardName } : {}),
      },
    });
    if (!health.online) {
      if (!router.maintenanceMode) await openAlert(organizationId, { routerId: router.id, type: "ROUTER_OFFLINE", severity: "warning", message: `${router.name} is unreachable: ${health.detail}`.slice(0, 300) });
      logger.warn({ routerId: router.id, organizationId, maintenance: router.maintenanceMode }, "router health check failed");
    } else {
      await db.routerAlert.updateMany({ where: { organizationId, routerId: router.id, type: "ROUTER_OFFLINE", status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: now } });
    }
  }
  return { checked: routers.length, online };
}

// ───────── Alerts ─────────

export async function listRouterAlerts(ctx: StaffContext, query: z.infer<typeof alertListQuery>) {
  requirePermission(ctx, "network.read");
  const visibleRouters = await db.router.findMany({ where: tenantWhere(ctx), select: { id: true, name: true } });
  const routerIds = visibleRouters.map((r) => r.id);
  if (query.routerId && !routerIds.includes(query.routerId)) throw notFound("router");
  const where: Prisma.RouterAlertWhereInput = {
    organizationId: ctx.organizationId,
    ...(query.status !== "ALL" ? { status: query.status } : {}),
    ...(query.routerId ? { routerId: query.routerId } : ctx.branchIds ? { OR: [{ routerId: { in: routerIds } }, { routerId: null }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.routerAlert.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.routerAlert.count({ where }),
  ]);
  return { rows: rows.map((a) => ({ ...a, routerName: visibleRouters.find((r) => r.id === a.routerId)?.name ?? null })), total };
}

export async function resolveRouterAlert(ctx: StaffContext, id: string, note?: string) {
  requirePermission(ctx, "network.operate");
  const alert = await db.routerAlert.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!alert) throw notFound("alert");
  if (alert.routerId) await findRouter(ctx, alert.routerId);
  if (alert.status === "RESOLVED") return alert;
  const updated = await db.routerAlert.update({ where: { id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
  await audit(ctx, { action: "network.alert.resolve", entityType: "router_alert", entityId: id, metadata: { type: alert.type, note: note ?? null } });
  return updated;
}
