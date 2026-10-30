import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { hasPermission, requirePermission, tenantWhere, type StaffContext } from "@/server/auth/context";
import { notFound } from "@/server/errors";
import { availability, bucketSeries, healthScore, incidents, reachabilityHeatmap, type TelemetrySample } from "@/server/domain/router-telemetry";
import { fromWallTime, toWallTime } from "@/server/domain/time";
import type { RouterMetricSample } from "@/generated/prisma/client";

/**
 * Router insights: telemetry charts and the health score (from health-check samples), stored log and diagnosis
 * snapshots, and the router's reports (collections, sessions, peak hours). Read-only; tenant and branch scoped.
 */

export const telemetryQuery = z.object({ range: z.enum(["24h", "7d", "30d"]).default("24h") });
export type TelemetryRange = z.infer<typeof telemetryQuery>["range"];

const RANGES: Record<TelemetryRange, { ms: number; bucketMs: number }> = {
  "24h": { ms: 86_400_000, bucketMs: 15 * 60_000 },
  "7d": { ms: 7 * 86_400_000, bucketMs: 2 * 3_600_000 },
  "30d": { ms: 30 * 86_400_000, bucketMs: 6 * 3_600_000 },
};

/** Samples and snapshots older than this are deleted by the daily maintenance job. */
export const TELEMETRY_RETENTION_DAYS = 35;

async function visibleRouter(ctx: StaffContext, id: string) {
  const router = await db.router.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true } });
  if (!router) throw notFound("router");
  return router;
}

function toSample(r: RouterMetricSample): TelemetrySample {
  return {
    takenAt: r.takenAt,
    reachable: r.reachable,
    simulated: r.simulated,
    responseMs: r.responseMs,
    cpuLoad: r.cpuLoad,
    memoryUsedPct: r.memoryUsedPct,
    diskUsedPct: r.diskUsedPct,
    temperatureC: r.temperatureC === null ? null : Number(r.temperatureC),
    uptimeSeconds: r.uptimeSeconds,
    rxBps: r.rxBps === null ? null : Number(r.rxBps),
    txBps: r.txBps === null ? null : Number(r.txBps),
    sessions: r.sessions,
  };
}

export async function routerTelemetry(ctx: StaffContext, routerId: string, query: z.infer<typeof telemetryQuery>) {
  requirePermission(ctx, "routers.read");
  await visibleRouter(ctx, routerId);
  const now = new Date();
  const range = RANGES[query.range];
  const from = new Date(now.getTime() - range.ms);
  // The heatmap always covers seven days, so read at least that far back.
  const rows = await db.routerMetricSample.findMany({
    where: { organizationId: ctx.organizationId, routerId, takenAt: { gte: new Date(now.getTime() - Math.max(range.ms, 7 * 86_400_000)) } },
    orderBy: { takenAt: "asc" },
  });
  const samples = rows.map(toSample);
  const inRange = samples.filter((s) => s.takenAt >= from);
  const lastDay = samples.filter((s) => s.takenAt.getTime() >= now.getTime() - 86_400_000);
  const latest = samples.at(-1) ?? null;
  const latestUp = [...samples].reverse().find((s) => s.reachable) ?? null;
  return {
    range: query.range,
    bucketMinutes: range.bucketMs / 60_000,
    from,
    to: now,
    simulated: inRange.some((s) => s.simulated),
    checks: inRange.length,
    availability: availability(inRange),
    score: healthScore(lastDay, now),
    latest: latest ? { takenAt: latest.takenAt, reachable: latest.reachable } : null,
    reading: latestUp,
    series: bucketSeries(inRange, from, now, range.bucketMs),
    heatmap: reachabilityHeatmap(samples, now, ctx.organization.timezone),
    incidents: incidents(inRange, now),
  };
}

/** The latest stored logs and diagnosis for a router (each is fetched on request by a network operation). */
export async function routerSnapshots(ctx: StaffContext, routerId: string) {
  requirePermission(ctx, "network.read");
  await visibleRouter(ctx, routerId);
  const latest = (kind: "logs" | "diagnosis") =>
    db.routerSnapshot.findFirst({ where: { organizationId: ctx.organizationId, routerId, kind }, orderBy: { takenAt: "desc" }, select: { id: true, kind: true, data: true, simulated: true, takenAt: true, operationId: true } });
  const [logs, diagnosis, pending] = await Promise.all([
    latest("logs"),
    latest("diagnosis"),
    db.networkOperation.findMany({ where: { organizationId: ctx.organizationId, routerId, type: { in: ["router.logs", "router.diagnose"] }, status: { in: ["QUEUED", "RUNNING", "RETRYING"] } }, select: { type: true } }),
  ]);
  return { logs, diagnosis, pending: { logs: pending.some((p) => p.type === "router.logs"), diagnosis: pending.some((p) => p.type === "router.diagnose") } };
}

const MONTHS = 6;

/** Month keys (YYYY-MM, local) for the last six months including the current one, and the instant the first starts. */
function recentMonths(now: Date, tz: string) {
  const w = toWallTime(now, tz);
  const keys: string[] = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(w.year, w.month - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const [y, m] = keys[0]!.split("-").map(Number) as [number, number];
  return { keys, start: fromWallTime({ year: y, month: m, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz) };
}

/**
 * Router reports. Collections are payments applied to invoices of subscriptions currently provisioned on this router
 * (shown only to staff who may view payments). Session figures come from session syncs; peak hours from health checks.
 */
export async function routerReport(ctx: StaffContext, routerId: string) {
  requirePermission(ctx, "routers.read");
  await visibleRouter(ctx, routerId);
  const tz = ctx.organization.timezone;
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const months = recentMonths(now, tz);
  const showMoney = hasPermission(ctx, "payments.read");
  const [collected, daily, totals, peak, subscriptions] = await Promise.all([
    showMoney
      ? db.$queryRaw<Array<{ month: string; total: string }>>`
          SELECT to_char(date_trunc('month', pa."createdAt" AT TIME ZONE ${tz}), 'YYYY-MM') AS month, COALESCE(SUM(pa."amount"), 0)::text AS total
          FROM "PaymentAllocation" pa
          JOIN "Invoice" i ON i."id" = pa."invoiceId"
          JOIN "Subscription" s ON s."id" = i."subscriptionId"
          WHERE pa."organizationId" = ${ctx.organizationId}::uuid AND pa."status" = 'ACTIVE' AND pa."createdAt" >= ${months.start}
            AND s."networkRouterId" = ${routerId}::uuid
          GROUP BY 1`
      : Promise.resolve(null),
    db.$queryRaw<Array<{ day: string; sessions: number; users: number }>>`
      SELECT to_char(ns."startedAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS sessions, COUNT(DISTINCT ns."username")::int AS users
      FROM "NetworkSession" ns
      WHERE ns."organizationId" = ${ctx.organizationId}::uuid AND ns."routerId" = ${routerId}::uuid AND ns."startedAt" >= ${since30}
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<Array<{ sessions: number; users: number; avg_seconds: number | null }>>`
      SELECT COUNT(*)::int AS sessions, COUNT(DISTINCT ns."username")::int AS users,
             AVG(EXTRACT(EPOCH FROM (ns."endedAt" - ns."startedAt"))) FILTER (WHERE ns."endedAt" IS NOT NULL)::float AS avg_seconds
      FROM "NetworkSession" ns
      WHERE ns."organizationId" = ${ctx.organizationId}::uuid AND ns."routerId" = ${routerId}::uuid AND ns."startedAt" >= ${since30}`,
    db.$queryRaw<Array<{ hour: number; avg: number }>>`
      SELECT EXTRACT(HOUR FROM m."takenAt" AT TIME ZONE ${tz})::int AS hour, AVG(m."sessions")::float AS avg
      FROM "RouterMetricSample" m
      WHERE m."organizationId" = ${ctx.organizationId}::uuid AND m."routerId" = ${routerId}::uuid AND m."takenAt" >= ${since30}
        AND m."reachable" AND m."sessions" IS NOT NULL
      GROUP BY 1`,
    db.subscription.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId, networkRouterId: routerId }, _count: { _all: true } }),
  ]);
  const byMonth = new Map((collected ?? []).map((r) => [r.month, r.total]));
  return {
    currency: ctx.organization.currency,
    collections: showMoney ? months.keys.map((month) => ({ month, amount: byMonth.get(month) ?? "0.00" })) : null,
    sessions: {
      days: daily,
      total: totals[0]?.sessions ?? 0,
      uniqueUsers: totals[0]?.users ?? 0,
      averageSeconds: totals[0]?.avg_seconds == null ? null : Math.round(totals[0].avg_seconds),
    },
    peakHours: Array.from({ length: 24 }, (_, hour) => {
      const row = peak.find((p) => p.hour === hour);
      return { hour, sessions: row ? Math.round(row.avg * 10) / 10 : null };
    }),
    subscriptions: Object.fromEntries(subscriptions.map((s) => [s.status, s._count._all])) as Record<string, number>,
  };
}

/** Daily: delete telemetry and snapshots past the retention window. */
export async function pruneRouterTelemetry(organizationId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_DAYS * 86_400_000);
  const [samples, snapshots] = await Promise.all([
    db.routerMetricSample.deleteMany({ where: { organizationId, takenAt: { lt: cutoff } } }),
    db.routerSnapshot.deleteMany({ where: { organizationId, takenAt: { lt: cutoff } } }),
  ]);
  return { samples: samples.count, snapshots: snapshots.count };
}
