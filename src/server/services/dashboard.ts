import "server-only";
import { db } from "@/server/db/client";
import { hasPermission, listWhere, requirePermission, type ActorContext } from "@/server/auth/context";
import { D, type DecimalValue } from "@/server/domain/money";
import { fromWallTime, toWallTime } from "@/server/domain/time";
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
