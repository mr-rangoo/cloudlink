import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, resolveBranchForCreate, systemContext, tenantWhere, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, forbidden, notFound } from "@/server/errors";
import { randomToken, sha256 } from "@/server/security/crypto";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { networkAdapterName } from "@/server/integrations/network";
import { logger } from "@/server/observability/logger";
import {
  AGENT_STALE_MS,
  MAX_DELIVERIES,
  REDELIVER_AFTER_MS,
  buildServicesScript,
  checkAgainstReport,
  guessWan,
  idleScript,
  parseAgentReport,
  parseAgentResult,
  servicePorts,
  servicesInput,
  simulatedReport,
  unlinkScript,
  wanChoices,
  type AgentReport,
  type ServicesConfig,
} from "@/server/domain/router-agent";
import { agentUrl, agentVerifyTls, appBaseUrl } from "@/server/services/router-setup";
import { routerHostPolicy, uniqueNameError } from "@/server/services/routers";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Link a MikroTik in four steps (Routers → Link MikroTik):
 *  1. Identity: name the router (creates a router record without an address or credentials);
 *  2. Provision: paste the one-time setup command; the script installs the Cloudlink agent, which checks in every minute;
 *  3. Services: choose hotspot and/or PPPoE, the ports to use and sharing limits; the agent applies it and confirms;
 *  4. Done.
 * The router only ever connects out to Cloudlink. Nothing here reports success that the router did not confirm:
 * "linked" means the router checked in, "applied" means the router confirmed the change.
 */

export const linkRouterInput = z.object({
  name: z.string().trim().min(2).max(80),
  branchId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export async function startRouterLink(ctx: StaffContext, raw: z.input<typeof linkRouterInput>) {
  requirePermission(ctx, "routers.write");
  const input = linkRouterInput.parse(raw);
  const branchId = await resolveBranchForCreate(ctx, input.branchId);
  const router = await db.router
    .create({
      data: { organizationId: ctx.organizationId, branchId, name: input.name, host: null, pppoeEnabled: false, hotspotEnabled: false, notes: input.notes ?? null },
      select: { id: true, name: true },
    })
    .catch(uniqueNameError);
  await audit(ctx, { action: "router.link.start", entityType: "router", entityId: router.id, metadata: { name: router.name } });
  return router;
}

/** Test mode only: a simulated router can stand in for real hardware (mock network adapter, never in production). */
export function simulationAllowed(): boolean {
  return networkAdapterName() === "mock" && (process.env.APP_ENV ?? "development") !== "production";
}

function reportOf(value: Prisma.JsonValue | null): AgentReport | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as unknown as AgentReport) : null;
}

function configOf(value: Prisma.JsonValue | null): ServicesConfig | null {
  const parsed = value ? servicesInput.safeParse(value) : null;
  return parsed?.success ? parsed.data : null;
}

export async function getRouterLink(ctx: StaffContext, id: string) {
  requirePermission(ctx, "routers.read");
  const router = await db.router.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!router) throw notFound("router");
  const report = reportOf(router.agentReport);
  const change = await db.routerChange.findFirst({ where: { routerId: id, organizationId: ctx.organizationId, status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "desc" } });
  const now = Date.now();
  return {
    id: router.id,
    name: router.name,
    archived: Boolean(router.archivedAt),
    host: router.host,
    identity: router.identity,
    routerOsVersion: router.routerOsVersion,
    boardName: router.boardName,
    setupPending: Boolean(router.setupExpiresAt && router.setupExpiresAt.getTime() > now),
    setupUsedAt: router.onboardedAt,
    linkedAt: router.linkedAt,
    agentLastSeenAt: router.agentLastSeenAt,
    agentOnline: Boolean(router.agentLastSeenAt && now - router.agentLastSeenAt.getTime() < AGENT_STALE_MS),
    simulated: Boolean(report?.simulated),
    ports: report ? servicePorts(report) : [],
    wanChoices: report ? wanChoices(report) : [],
    wanGuess: report ? guessWan(report) : null,
    services: configOf(router.servicesConfig),
    hotspotDnsName: router.hotspotDnsName,
    change: change ? { id: change.id, status: change.status, error: change.error, createdAt: change.createdAt, deliveredAt: change.deliveredAt, appliedAt: change.appliedAt, deliveries: change.deliveries } : null,
    canSimulate: simulationAllowed(),
    adapter: networkAdapterName(),
  };
}

/** Step 3: save the services and queue them for the router's next check-in. */
export async function saveRouterServices(ctx: StaffContext, id: string, raw: z.input<typeof servicesInput>) {
  requirePermission(ctx, "routers.write");
  const input = servicesInput.parse(raw);
  const router = await db.router.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!router) throw notFound("router");
  if (router.archivedAt) throw new AppError("INVALID_STATE", "Archived routers cannot be changed.");
  const report = reportOf(router.agentReport);
  if (!router.linkedAt || !report) throw new AppError("INVALID_STATE", "The router has not checked in yet. Run the setup command on it first (step 2).");
  const problems = checkAgainstReport(input, report);
  if (problems.length) throw new AppError("VALIDATION_ERROR", problems[0]!.message, { fields: problems });
  const change = await db.$transaction(async (tx) => {
    await tx.routerChange.updateMany({ where: { routerId: id, status: { in: ["PENDING", "DELIVERED"] } }, data: { status: "SUPERSEDED" } });
    const created = await tx.routerChange.create({ data: { organizationId: ctx.organizationId, routerId: id, kind: "services", config: input, requestedById: ctx.userId } });
    await tx.router.update({
      where: { id },
      data: {
        servicesConfig: input,
        hotspotEnabled: input.hotspot,
        pppoeEnabled: input.pppoe,
        uplinkInterface: input.wanInterface,
        ...(input.hotspot ? { hotspotDnsName: input.hotspotDnsName } : {}),
      },
    });
    return created;
  });
  await audit(ctx, {
    action: "router.services.update",
    entityType: "router",
    entityId: id,
    metadata: { changeId: change.id, hotspot: input.hotspot, pppoe: input.pppoe, ports: input.ports.map((p) => `${p.name}:${p.use}`), wan: input.wanInterface, devicesPerLogin: input.devicesPerLogin, blockSharing: input.blockSharing },
  });
  return { changeId: change.id, status: change.status };
}

// ───────── Agent endpoints (no session: the per-router key in the path is the credential) ─────────

const KEY_RE = /^[A-Za-z0-9_-]{30,100}$/;
const NOT_LINKED = "# This router is not linked to Cloudlink (or was linked again with a new command). Run the setup command from Cloudlink.\n";

/** One change for this check-in, or null. Claims it atomically so two check-ins never both deliver it. */
async function nextChange(routerId: string, now: Date) {
  const change = await db.routerChange.findFirst({ where: { routerId, status: { in: ["PENDING", "DELIVERED"] } }, orderBy: { createdAt: "asc" } });
  if (!change) return null;
  if (change.status === "DELIVERED" && change.deliveredAt && now.getTime() - change.deliveredAt.getTime() < REDELIVER_AFTER_MS) return null;
  if (change.deliveries >= MAX_DELIVERIES) {
    await db.routerChange.updateMany({
      where: { id: change.id, status: "DELIVERED" },
      data: { status: "FAILED", error: `The router did not confirm the change after ${MAX_DELIVERIES} attempts. Check the router log (System → Logs) for lines starting with "Cloudlink".` },
    });
    return null;
  }
  const claimed = await db.routerChange.updateMany({ where: { id: change.id, status: change.status, deliveries: change.deliveries }, data: { status: "DELIVERED", deliveries: { increment: 1 }, deliveredAt: now } });
  return claimed.count ? change : null;
}

/** The first reported address inside MIKROTIK_ALLOWED_NETWORKS (explicitly configured) becomes the API address. */
function managementAddress(report: AgentReport): string | null {
  if (!(process.env.MIKROTIK_ALLOWED_NETWORKS ?? "").trim()) return null;
  for (const a of report.addresses) {
    const ip = a.address.split("/")[0]!;
    if (routerHostPolicy(ip).ok) return ip;
  }
  return null;
}

/** POST /api/v1/routers/agent/:key: the router's check-in. Answers with a RouterOS script to import. */
export async function agentCheckIn(key: string, body: string, meta: { ipAddress: string | null; correlationId: string }, opts: { simulatedReport?: AgentReport } = {}): Promise<{ status: number; body: string }> {
  if (!KEY_RE.test(key)) return { status: 404, body: NOT_LINKED };
  const keyHash = sha256(key);
  if (!opts.simulatedReport) await consumeRateLimit({ name: "router:agent", limit: 12, windowSeconds: 60 }, keyHash);
  const router = await db.router.findUnique({ where: { agentKeyHash: keyHash } });
  if (!router) return { status: 404, body: NOT_LINKED };
  if (router.archivedAt) return { status: 200, body: unlinkScript() };

  const now = new Date();
  const report: AgentReport = opts.simulatedReport ? { ...opts.simulatedReport, simulated: true } : parseAgentReport(body);
  const firstContact = !router.linkedAt;
  const host = !router.host && !report.simulated ? managementAddress(report) : null;
  const agentOnly = !router.host && !host;
  await db.router.update({
    where: { id: router.id },
    data: {
      agentLastSeenAt: now,
      agentReport: report as unknown as Prisma.InputJsonValue,
      linkedAt: router.linkedAt ?? now,
      ...(report.simulated ? {} : { identity: report.identity ?? router.identity, routerOsVersion: report.version ?? router.routerOsVersion, boardName: report.board ?? router.boardName }),
      ...(host ? { host } : {}),
      // Routers without an API address are judged by their check-ins.
      ...(agentOnly ? { status: report.simulated ? "UNKNOWN" : "ONLINE", lastCheckedAt: now, lastError: null, ...(report.simulated ? {} : { lastSeenAt: now }) } : {}),
    },
  });
  if (agentOnly) await db.routerAlert.updateMany({ where: { organizationId: router.organizationId, routerId: router.id, type: "ROUTER_OFFLINE", status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: now } });
  if (firstContact || host) {
    const ctx = systemContext(router.organizationId, "router:agent", meta.correlationId);
    if (firstContact) await audit(ctx, { action: "router.link.connected", entityType: "router", entityId: router.id, metadata: { sourceIp: meta.ipAddress, simulated: Boolean(report.simulated), version: report.version, board: report.board } });
    if (host) await audit(ctx, { action: "router.link.address", entityType: "router", entityId: router.id, metadata: { host } });
  }

  const change = await nextChange(router.id, now);
  if (!change) return { status: 200, body: idleScript(now) };
  const config = configOf(change.config);
  if (!config) {
    await db.routerChange.update({ where: { id: change.id }, data: { status: "FAILED", error: "The saved change is no longer valid. Save the services again." } });
    return { status: 200, body: idleScript(now) };
  }
  let portalHost: string | null = null;
  try {
    portalHost = new URL(appBaseUrl()).hostname;
  } catch {
    portalHost = null;
  }
  logger.info({ routerId: router.id, changeId: change.id, correlationId: meta.correlationId }, "router change delivered");
  return {
    status: 200,
    body: buildServicesScript({
      routerName: router.name,
      changeId: change.id,
      config,
      resultUrl: `${agentUrl(key)}/result`,
      verifyTls: agentVerifyTls(),
      portalHost,
      loginUrl: portalHost && config.hotspot ? `${appBaseUrl()}/api/v1/hotspot-files/${router.id}/login.html` : null,
      generatedAt: now,
    }),
  };
}

/** POST /api/v1/routers/agent/:key/result: the router confirms (or reports failure of) the change it imported. */
export async function agentResult(key: string, body: string, meta: { ipAddress: string | null; correlationId: string }): Promise<{ status: number; body: string }> {
  if (!KEY_RE.test(key)) return { status: 404, body: NOT_LINKED };
  const keyHash = sha256(key);
  await consumeRateLimit({ name: "router:agent-result", limit: 12, windowSeconds: 60 }, keyHash);
  const router = await db.router.findUnique({ where: { agentKeyHash: keyHash }, select: { id: true, organizationId: true } });
  if (!router) return { status: 404, body: NOT_LINKED };
  const result = parseAgentResult(body);
  const now = new Date();
  const ctx = systemContext(router.organizationId, "router:agent", meta.correlationId);
  if (result.status === "applied" && result.changeId) {
    const done = await db.routerChange.updateMany({ where: { id: result.changeId, routerId: router.id, status: "DELIVERED" }, data: { status: "APPLIED", appliedAt: now, error: null } });
    if (done.count) await audit(ctx, { action: "router.services.applied", entityType: "router", entityId: router.id, metadata: { changeId: result.changeId } });
    return { status: 200, body: "ok\n" };
  }
  if (result.status === "failed") {
    const latest = await db.routerChange.findFirst({ where: { routerId: router.id, status: "DELIVERED" }, orderBy: { deliveredAt: "desc" } });
    if (latest) {
      await db.routerChange.update({
        where: { id: latest.id },
        data: { status: "FAILED", error: 'The router reported an error while applying the change. Check the router log (System → Logs) for lines starting with "Cloudlink", then save the services again.' },
      });
      await audit(ctx, { action: "router.services.failed", entityType: "router", entityId: router.id, metadata: { changeId: latest.id } });
    }
    return { status: 200, body: "ok\n" };
  }
  return { status: 400, body: "unrecognised result\n" };
}

/**
 * Test mode: stand in for the router. Runs the setup (new agent key), checks in with a report like a MikroTik with its
 * default configuration, and confirms any change it was given. Everything it records is marked as simulated.
 */
export async function simulateRouter(ctx: StaffContext, id: string) {
  requirePermission(ctx, "routers.write");
  if (!simulationAllowed()) throw forbidden("Simulation is only available in test mode (mock network adapter, outside production).");
  const router = await db.router.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!router) throw notFound("router");
  if (router.archivedAt) throw new AppError("INVALID_STATE", "Archived routers cannot be changed.");
  if (!router.linkedAt && !router.setupTokenHash) throw new AppError("INVALID_STATE", "Generate the setup command first.");
  const key = randomToken(32);
  const now = new Date();
  await db.router.update({
    where: { id },
    data: { agentKeyHash: sha256(key), ...(router.linkedAt ? {} : { setupTokenHash: null, setupExpiresAt: null, onboardedAt: now, onboardedFromIp: null }) },
  });
  const meta = { ipAddress: null, correlationId: ctx.correlationId };
  const report = simulatedReport(router.name, configOf(router.servicesConfig));
  const res = await agentCheckIn(key, "", meta, { simulatedReport: report });
  const changeId = /^# Change ([0-9a-f-]{36}),/m.exec(res.body)?.[1] ?? null;
  if (changeId) {
    await agentResult(key, `status=applied&change=${changeId}`, meta);
    // The router now reports its new layout.
    const after = await db.router.findUniqueOrThrow({ where: { id }, select: { servicesConfig: true } });
    await db.router.update({ where: { id }, data: { agentReport: simulatedReport(router.name, configOf(after.servicesConfig)) as unknown as Prisma.InputJsonValue } });
  }
  await audit(ctx, { action: "router.link.simulate", entityType: "router", entityId: id, metadata: { appliedChange: changeId } });
  return { simulated: true, appliedChange: changeId };
}
