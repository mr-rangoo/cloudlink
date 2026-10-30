import "server-only";
import { db } from "@/server/db/client";
import { hasPermission, listWhere, requirePermission, type ActorContext, type StaffContext } from "@/server/auth/context";
import { D, type DecimalValue } from "@/server/domain/money";
import { addLocalDays, fromWallTime, localDateKey, startOfLocalDay, toWallTime } from "@/server/domain/time";
import { healthScore, type TelemetrySample } from "@/server/domain/router-telemetry";
import { branchFilterSql } from "@/server/services/common";
import { Prisma } from "@/generated/prisma/client";
import type { BillingUnit } from "@/server/domain/billing-period";

/**
 * Dashboard metric definitions (also shown in the UI):
 * - Subscribers: non-archived subscriber accounts in scope.
 * - Active / suspended / expired / pending: subscriptions by current billing status.
 * - Expiring soon: ACTIVE subscriptions whose paid period ends within 7 days.
 * - Recurring revenue (MRR): sum of ACTIVE subscription snapshot prices normalised to one month
 *   (yearly ÷ 12, weekly × 52 ÷ 12, daily × 365 ÷ 12, hourly × 24 × 365 ÷ 12), excluding tax. Grouped by currency.
 * - New this month / leads won this month: calendar month in the organization timezone.
 * - Receivables: sum of balanceDue on OPEN and PARTIALLY_PAID invoices. Overdue: those past dueAt.
 * - Collected this month: CONFIRMED payments received since the start of the month (incl. later-refunded ones).
 * - Payment exceptions: confirmed payments not matched to a subscriber.
 */
export function monthlyEquivalent(price: DecimalValue, unit: BillingUnit, count: number): DecimalValue {
  const perUnit = price.div(count);
  switch (unit) {
    case "MONTH":
      return perUnit;
    case "YEAR":
      return perUnit.div(12);
    case "WEEK":
      return perUnit.mul(52).div(12);
    case "DAY":
      return perUnit.mul(365).div(12);
    case "HOUR":
      return perUnit.mul(24 * 365).div(12);
    case "MINUTE":
      return perUnit.mul(60 * 24 * 365).div(12);
  }
}

function startOfMonth(now: Date, tz: string): Date {
  const w = toWallTime(now, tz);
  return fromWallTime({ year: w.year, month: w.month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
}

export async function dashboardSummary(ctx: ActorContext & { organization: { timezone: string; currency: string } }) {
  requirePermission(ctx, "dashboard.view");
  const scope = listWhere(ctx);
  const now = new Date();
  const monthStart = startOfMonth(now, ctx.organization.timezone);
  const canSubs = hasPermission(ctx, "subscribers.read");
  const canSubscriptions = hasPermission(ctx, "subscriptions.read");
  const canLeads = hasPermission(ctx, "leads.read");
  const canInvoices = hasPermission(ctx, "invoices.read");
  const canPayments = hasPermission(ctx, "payments.read");

  const open = { in: ["OPEN", "PARTIALLY_PAID"] as Array<"OPEN" | "PARTIALLY_PAID"> };
  const [receivables, overdue, collected, unmatched] = await Promise.all([
    canInvoices ? db.invoice.aggregate({ where: { ...scope, status: open }, _sum: { balanceDue: true }, _count: { _all: true } }) : null,
    canInvoices ? db.invoice.aggregate({ where: { ...scope, status: open, dueAt: { lt: now } }, _sum: { balanceDue: true }, _count: { _all: true } }) : null,
    canPayments ? db.payment.aggregate({ where: { ...scope, status: "CONFIRMED", receivedAt: { gte: monthStart } }, _sum: { amount: true }, _count: { _all: true } }) : null,
    canPayments ? db.payment.count({ where: { organizationId: ctx.organizationId, status: "CONFIRMED", subscriberId: null } }) : null,
  ]);

  const [subscriberCount, newSubscribers, statusGroups, expiringSoon, activeForMrr, openLeads, wonThisMonth] = await Promise.all([
    canSubs ? db.subscriber.count({ where: { ...scope, status: { not: "ARCHIVED" } } }) : null,
    canSubs ? db.subscriber.count({ where: { ...scope, createdAt: { gte: monthStart } } }) : null,
    canSubscriptions ? db.subscription.groupBy({ by: ["status"], where: scope, _count: { _all: true } }) : null,
    canSubscriptions ? db.subscription.count({ where: { ...scope, status: "ACTIVE", currentPeriodEnd: { lte: new Date(now.getTime() + 7 * 86_400_000), gte: now } } }) : null,
    canSubscriptions ? db.subscription.findMany({ where: { ...scope, status: "ACTIVE" }, select: { price: true, currency: true, billingUnit: true, billingCount: true } }) : null,
    canLeads ? db.lead.count({ where: { ...scope, stage: { notIn: ["WON", "LOST"] } } }) : null,
    canLeads ? db.lead.count({ where: { ...scope, convertedAt: { gte: monthStart } } }) : null,
  ]);

  const byStatus = Object.fromEntries((statusGroups ?? []).map((g) => [g.status, g._count._all])) as Record<string, number>;
  const mrr = new Map<string, DecimalValue>();
  for (const s of activeForMrr ?? []) {
    const m = monthlyEquivalent(new D(s.price.toString()), s.billingUnit, s.billingCount);
    mrr.set(s.currency, (mrr.get(s.currency) ?? new D(0)).plus(m));
  }

  return {
    generatedAt: now.toISOString(),
    subscribers: subscriberCount === null ? null : { total: subscriberCount, newThisMonth: newSubscribers ?? 0 },
    subscriptions: statusGroups === null
      ? null
      : {
          active: byStatus.ACTIVE ?? 0,
          suspended: byStatus.SUSPENDED ?? 0,
          expired: byStatus.EXPIRED ?? 0,
          pending: byStatus.PENDING ?? 0,
          cancelled: byStatus.CANCELLED ?? 0,
          expiringIn7Days: expiringSoon ?? 0,
        },
    recurringRevenue: activeForMrr === null ? null : [...mrr.entries()].map(([currency, amount]) => ({ currency, monthly: amount.toFixed(2) })),
    leads: openLeads === null ? null : { open: openLeads, wonThisMonth: wonThisMonth ?? 0 },
    billing: receivables === null ? null : {
      receivables: (receivables._sum.balanceDue ?? 0).toString(),
      openInvoices: receivables._count._all,
      overdue: (overdue?._sum.balanceDue ?? 0).toString(),
      overdueInvoices: overdue?._count._all ?? 0,
    },
    collections: collected === null ? null : { thisMonth: (collected._sum.amount ?? 0).toString(), payments: collected._count._all, unmatchedPayments: unmatched ?? 0 },
    network: await networkSummary(ctx, now),
    support: await supportSummary(ctx),
  };
}

/**
 * Network metrics (routers.read / network.read):
 * - Routers: non-archived routers in scope by last health-check status ("not checked" includes mock-simulated checks).
 * - Operations in progress: QUEUED, RUNNING or RETRYING now. Failed: FAILED and completed in the last 7 days.
 *   Completed: SUCCEEDED or SIMULATED in the last 24 hours (simulated ones are counted separately).
 * - Open alerts and active sessions: current counts.
 */
async function networkSummary(ctx: ActorContext, now: Date) {
  const canRouters = hasPermission(ctx, "routers.read");
  const canNetwork = hasPermission(ctx, "network.read");
  if (!canRouters && !canNetwork) return null;
  const org = ctx.organizationId;
  const routerScope = { ...listWhere(ctx), archivedAt: null };
  const visible = ctx.kind === "staff" && ctx.branchIds ? (await db.router.findMany({ where: routerScope, select: { id: true } })).map((r) => r.id) : null;
  const opScope = { organizationId: org, ...(visible ? { routerId: { in: visible } } : {}) };
  const [routerGroups, inProgress, failed7d, completed, openAlerts, activeSessions] = await Promise.all([
    canRouters ? db.router.groupBy({ by: ["status"], where: routerScope, _count: { _all: true } }) : null,
    canNetwork ? db.networkOperation.count({ where: { ...opScope, status: { in: ["QUEUED", "RUNNING", "RETRYING"] } } }) : null,
    canNetwork ? db.networkOperation.count({ where: { ...opScope, status: "FAILED", completedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }) : null,
    canNetwork ? db.networkOperation.groupBy({ by: ["status"], where: { ...opScope, status: { in: ["SUCCEEDED", "SIMULATED"] }, completedAt: { gte: new Date(now.getTime() - 86_400_000) } }, _count: { _all: true } }) : null,
    canNetwork ? db.routerAlert.count({ where: { organizationId: org, status: "OPEN", ...(visible ? { OR: [{ routerId: { in: visible } }, { routerId: null }] } : {}) } }) : null,
    canNetwork ? db.networkSession.count({ where: { organizationId: org, endedAt: null, ...(visible ? { routerId: { in: visible } } : {}) } }) : null,
  ]);
  const r = Object.fromEntries((routerGroups ?? []).map((g) => [g.status, g._count._all])) as Record<string, number>;
  const c = Object.fromEntries((completed ?? []).map((g) => [g.status, g._count._all])) as Record<string, number>;
  return {
    routers: routerGroups === null ? null : { total: Object.values(r).reduce((a, b) => a + b, 0), online: r.ONLINE ?? 0, offline: (r.OFFLINE ?? 0) + (r.ERROR ?? 0), notChecked: r.UNKNOWN ?? 0 },
    operations: inProgress === null ? null : { inProgress, failed7d: failed7d ?? 0, succeeded24h: c.SUCCEEDED ?? 0, simulated24h: c.SIMULATED ?? 0 },
    openAlerts,
    activeSessions,
  };
}

/** Support workload (support.read): open = OPEN, IN_PROGRESS or WAITING_ON_CUSTOMER; urgent = HIGH/URGENT without an owner. */
async function supportSummary(ctx: ActorContext) {
  if (!hasPermission(ctx, "support.read")) return null;
  const scope = listWhere(ctx);
  const open = { in: ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER"] as Array<"OPEN" | "IN_PROGRESS" | "WAITING_ON_CUSTOMER"> };
  const [openTickets, urgentUnassigned] = await Promise.all([
    db.supportTicket.count({ where: { ...scope, status: open } }),
    db.supportTicket.count({ where: { ...scope, status: open, priority: { in: ["HIGH", "URGENT"] }, assigneeId: null } }),
  ]);
  return { openTickets, urgentUnassigned };
}

/**
 * Overview "pulse" (each part only with its permission):
 * - Collected today / yesterday: CONFIRMED payments in the organization currency by local day; "by this time" compares
 *   today with yesterday up to the same time of day.
 * - Collections, 14 days: the same per local day.
 * - Expiring in 24 hours: ACTIVE subscriptions whose paid period ends within the next 24 hours (first 8 listed).
 * - Renewals due: OPEN / PARTIALLY_PAID invoices due within the next 3 days.
 * - Online / offline: ACTIVE subscriptions with network access, by whether a session for their username is open now.
 * - Expired, 7 days: subscriptions that are EXPIRED and whose period ended in the last 7 days (not renewed).
 * - Busiest routers: most open sessions now, with the 24-hour health score.
 */
export async function dashboardPulse(ctx: StaffContext) {
  requirePermission(ctx, "dashboard.view");
  const scope = listWhere(ctx);
  const tz = ctx.organization.timezone;
  const currency = ctx.organization.currency;
  const now = new Date();
  const today = startOfLocalDay(now, tz);
  const yesterday = addLocalDays(today, -1, tz);
  const sameTimeYesterday = new Date(yesterday.getTime() + (now.getTime() - today.getTime()));
  const first = addLocalDays(today, -13, tz);
  const canPayments = hasPermission(ctx, "payments.read");
  const canSubscriptions = hasPermission(ctx, "subscriptions.read");
  const canInvoices = hasPermission(ctx, "invoices.read");
  const canNetwork = hasPermission(ctx, "network.read");
  const canRouters = hasPermission(ctx, "routers.read");
  const in24h = new Date(now.getTime() + 86_400_000);

  const [daily, yesterdayByNow, payments, expiring, expiringCount, renewals, health, expired7d, busiest] = await Promise.all([
    canPayments
      ? db.$queryRaw<Array<{ day: string; total: string; n: number }>>`
          SELECT to_char(p."receivedAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, SUM(p."amount")::text AS total, COUNT(*)::int AS n
          FROM "Payment" p
          WHERE p."organizationId" = ${ctx.organizationId}::uuid AND p."status" = 'CONFIRMED' AND p."currency" = ${currency}
            AND p."receivedAt" >= ${first} AND p."receivedAt" <= ${now} ${branchFilterSql(ctx, Prisma.sql`p."branchId"`)}
          GROUP BY 1`
      : null,
    canPayments ? db.payment.aggregate({ where: { ...scope, status: "CONFIRMED", currency, receivedAt: { gte: yesterday, lt: sameTimeYesterday } }, _sum: { amount: true } }) : null,
    canPayments
      ? db.payment.findMany({
          where: { ...scope, status: "CONFIRMED" },
          orderBy: { receivedAt: "desc" },
          take: 8,
          select: { id: true, amount: true, currency: true, method: true, receivedAt: true, receiptNumber: true, subscriberId: true },
        })
      : null,
    canSubscriptions
      ? db.subscription.findMany({
          where: { ...scope, status: "ACTIVE", currentPeriodEnd: { gte: now, lte: in24h } },
          orderBy: { currentPeriodEnd: "asc" },
          take: 8,
          select: { id: true, packageName: true, currentPeriodEnd: true, subscriber: { select: { id: true, displayName: true, accountNumber: true } } },
        })
      : null,
    canSubscriptions ? db.subscription.count({ where: { ...scope, status: "ACTIVE", currentPeriodEnd: { gte: now, lte: in24h } } }) : null,
    canInvoices
      ? db.invoice.aggregate({ where: { ...scope, status: { in: ["OPEN", "PARTIALLY_PAID"] }, dueAt: { gte: now, lte: new Date(now.getTime() + 3 * 86_400_000) } }, _sum: { balanceDue: true }, _count: { _all: true } })
      : null,
    canSubscriptions && canNetwork
      ? db.$queryRaw<Array<{ provisioned: number; online: number }>>`
          SELECT COUNT(*)::int AS provisioned,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM "NetworkSession" ns WHERE ns."organizationId" = s."organizationId" AND ns."username" = s."networkUsername" AND ns."endedAt" IS NULL
                 ))::int AS online
          FROM "Subscription" s
          WHERE s."organizationId" = ${ctx.organizationId}::uuid AND s."status" = 'ACTIVE' AND s."networkUsername" IS NOT NULL
            ${branchFilterSql(ctx, Prisma.sql`s."branchId"`)}`
      : null,
    canSubscriptions ? db.subscription.count({ where: { ...scope, status: "EXPIRED", currentPeriodEnd: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }) : null,
    canRouters && canNetwork ? busiestRouters(ctx, now) : null,
  ]);

  const payers = payments?.length
    ? await db.subscriber.findMany({ where: { organizationId: ctx.organizationId, id: { in: payments.flatMap((p) => (p.subscriberId ? [p.subscriberId] : [])) } }, select: { id: true, displayName: true } })
    : [];
  const byDay = new Map((daily ?? []).map((d) => [d.day, d]));
  const days = Array.from({ length: 14 }, (_, i) => localDateKey(addLocalDays(first, i, tz), tz));
  const todayKey = localDateKey(now, tz);
  const yesterdayKey = localDateKey(yesterday, tz);
  return {
    collections: daily
      ? {
          currency,
          today: money(byDay.get(todayKey)?.total),
          todayPayments: byDay.get(todayKey)?.n ?? 0,
          yesterday: money(byDay.get(yesterdayKey)?.total),
          yesterdayByNow: money(yesterdayByNow?._sum.amount),
          days: days.map((day) => ({ day, amount: money(byDay.get(day)?.total), payments: byDay.get(day)?.n ?? 0 })),
        }
      : null,
    recentPayments: payments?.map(({ subscriberId, ...p }) => ({ ...p, amount: money(p.amount), subscriber: payers.find((s) => s.id === subscriberId) ?? null })) ?? null,
    expiring: expiring ? { count: expiringCount ?? 0, rows: expiring } : null,
    renewalsDue: renewals ? { count: renewals._count._all, amount: money(renewals._sum.balanceDue) } : null,
    subscriberHealth: health ? { provisioned: health[0]?.provisioned ?? 0, online: health[0]?.online ?? 0, expired7d: expired7d ?? 0 } : null,
    busiestRouters: busiest,
  };
}

/**
 * Small counts shown next to sidebar items (each only with its permission, in the caller's scope):
 * sessions open now, routers offline, open support tickets, confirmed payments not matched to a subscriber.
 */
export async function navigationCounts(ctx: StaffContext) {
  const visibleRouters = hasPermission(ctx, "network.read") && ctx.branchIds ? (await db.router.findMany({ where: { ...listWhere(ctx), archivedAt: null }, select: { id: true } })).map((r) => r.id) : null;
  const [sessions, routersOffline, support, reconciliation] = await Promise.all([
    hasPermission(ctx, "network.read") ? db.networkSession.count({ where: { organizationId: ctx.organizationId, endedAt: null, ...(visibleRouters ? { routerId: { in: visibleRouters } } : {}) } }) : null,
    hasPermission(ctx, "routers.read") ? db.router.count({ where: { ...listWhere(ctx), archivedAt: null, status: { in: ["OFFLINE", "ERROR"] } } }) : null,
    hasPermission(ctx, "support.read") ? db.supportTicket.count({ where: { ...listWhere(ctx), status: { in: ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER"] } } }) : null,
    hasPermission(ctx, "payments.reconcile") ? db.payment.count({ where: { organizationId: ctx.organizationId, status: "CONFIRMED", subscriberId: null } }) : null,
  ]);
  return { sessions, routersOffline, support, reconciliation };
}

/** Money as a two-decimal string (missing = 0.00). */
const money = (v: { toString(): string } | string | null | undefined) => new D(v === null || v === undefined ? 0 : v.toString()).toFixed(2);

async function busiestRouters(ctx: StaffContext, now: Date) {
  const routers = await db.router.findMany({ where: { ...listWhere(ctx), archivedAt: null }, select: { id: true, name: true, status: true, maintenanceMode: true } });
  if (!routers.length) return [];
  const sessions = await db.networkSession.groupBy({ by: ["routerId"], where: { organizationId: ctx.organizationId, endedAt: null, routerId: { in: routers.map((r) => r.id) } }, _count: { _all: true } });
  const count = (id: string) => sessions.find((s) => s.routerId === id)?._count._all ?? 0;
  const top = [...routers].sort((a, b) => count(b.id) - count(a.id) || a.name.localeCompare(b.name)).slice(0, 5);
  const samples = await db.routerMetricSample.findMany({
    where: { organizationId: ctx.organizationId, routerId: { in: top.map((r) => r.id) }, takenAt: { gte: new Date(now.getTime() - 86_400_000) } },
    select: { routerId: true, takenAt: true, reachable: true, simulated: true, responseMs: true, cpuLoad: true, memoryUsedPct: true, diskUsedPct: true },
  });
  return top.map((r) => {
    const mine: TelemetrySample[] = samples.filter((s) => s.routerId === r.id).map((s) => ({ ...s, temperatureC: null, uptimeSeconds: null, rxBps: null, txBps: null, sessions: null }));
    return { ...r, sessions: count(r.id), health: healthScore(mine, now) };
  });
}

export async function dashboardActivity(ctx: ActorContext, take = 15) {
  requirePermission(ctx, "dashboard.view");
  const canSubs = hasPermission(ctx, "subscribers.read");
  if (!canSubs) return [];
  const rows = await db.subscriberActivity.findMany({
    where: { organizationId: ctx.organizationId, ...(ctx.kind === "staff" && (ctx.branchIds || ctx.activeBranchId) ? { subscriber: listWhere(ctx) } : {}) },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, type: true, message: true, createdAt: true, subscriber: { select: { id: true, displayName: true, accountNumber: true } } },
  });
  return rows;
}

/**
 * First-steps checklist for a new workspace (administrators only). Returns null once every step is done, so
 * established organizations never see it.
 */
export async function gettingStarted(ctx: StaffContext) {
  if (!ctx.permissions.has("settings.write")) return null;
  const org = ctx.organizationId;
  const [plans, routers, subscribers, methods, members, branding] = await Promise.all([
    db.package.count({ where: { organizationId: org } }),
    db.router.count({ where: { organizationId: org, archivedAt: null } }),
    db.subscriber.count({ where: { organizationId: org } }),
    db.customerPaymentMethod.count({ where: { organizationId: org } }),
    db.membership.count({ where: { organizationId: org } }),
    db.organizationBranding.count({ where: { organizationId: org } }),
  ]);
  const steps = [
    { key: "plan", label: "Create your first internet plan", href: "/packages", done: plans > 0 },
    { key: "payments", label: "Add how customers pay you (M-Pesa paybill, till or bank)", href: "/settings?tab=payments", done: methods > 0 },
    { key: "router", label: "Connect a MikroTik router", href: "/routers", done: routers > 0 },
    { key: "subscriber", label: "Add or import your subscribers", href: "/subscribers", done: subscribers > 0 },
    { key: "branding", label: "Add your logo and colours", href: "/settings?tab=branding", done: branding > 0 },
    { key: "team", label: "Invite your team", href: "/staff", done: members > 1 },
  ];
  return steps.every((s) => s.done) ? null : steps;
}
