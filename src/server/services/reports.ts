import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { D } from "@/server/domain/money";
import { fromWallTime, toWallTime } from "@/server/domain/time";
import { monthlyEquivalent } from "@/server/services/dashboard";

/**
 * Reports. Financial figures come from the double-entry ledger (the source of truth), so reports always agree
 * with the books. Months are calendar months in the organization timezone.
 *
 * Definitions (also shown in the UI):
 * - Revenue: credits − debits on Service revenue (4000) — invoices issued, less voids.
 * - Credit notes: debits − credits on Credit notes and allowances (4100).
 * - Net revenue: Revenue − Credit notes. Excludes tax.
 * - Tax: net credits on Tax payable (2200).
 * - Collected: debits to cash/bank/M-Pesa from payment receipts, less refunds and payment reversals.
 * - Expenses: net debits on Operating expenses (5000).
 * - Receivables aging: open invoice balances grouped by days past due date.
 */
export const reportRangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export interface MonthRange {
  start: Date;
  end: Date;
  months: string[];
}

export function resolveMonthRange(tz: string, from?: string, to?: string, now = new Date()): MonthRange {
  const w = toWallTime(now, tz);
  const parse = (v: string | undefined, fallback: [number, number]): [number, number] => (v ? (v.split("-").map(Number) as [number, number]) : fallback);
  const endYm = parse(to, [w.year, w.month]);
  const defaultStart = new Date(Date.UTC(endYm[0], endYm[1] - 1 - 11, 1));
  let startYm = parse(from, [defaultStart.getUTCFullYear(), defaultStart.getUTCMonth() + 1]);
  if (startYm[0] * 12 + startYm[1] > endYm[0] * 12 + endYm[1]) startYm = endYm;
  if (endYm[0] * 12 + endYm[1] - (startYm[0] * 12 + startYm[1]) > 35) {
    const s = new Date(Date.UTC(endYm[0], endYm[1] - 1 - 35, 1));
    startYm = [s.getUTCFullYear(), s.getUTCMonth() + 1];
  }
  const months: string[] = [];
  for (let y = startYm[0], m = startYm[1]; y * 12 + m <= endYm[0] * 12 + endYm[1]; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  const start = fromWallTime({ year: startYm[0], month: startYm[1], day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
  const next = endYm[1] === 12 ? [endYm[0] + 1, 1] : [endYm[0], endYm[1] + 1];
  const end = fromWallTime({ year: next[0]!, month: next[1]!, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
  return { start, end, months };
}

export async function revenueReport(ctx: StaffContext, q: z.infer<typeof reportRangeQuery>) {
  requirePermission(ctx, "reports.read");
  const tz = ctx.organization.timezone;
  const range = resolveMonthRange(tz, q.from, q.to);
  const rows = await db.$queryRaw<Array<{ month: string; code: string; type: string; debit: string; credit: string }>>`
    SELECT to_char(date_trunc('month', t."occurredAt" AT TIME ZONE ${tz}), 'YYYY-MM') AS month,
           a."code", t."type", COALESCE(SUM(e."debit"), 0)::text AS debit, COALESCE(SUM(e."credit"), 0)::text AS credit
    FROM "LedgerEntry" e
    JOIN "LedgerTransaction" t ON t."id" = e."transactionId"
    JOIN "LedgerAccount" a ON a."id" = e."accountId"
    WHERE e."organizationId" = ${ctx.organizationId}::uuid AND t."occurredAt" >= ${range.start} AND t."occurredAt" < ${range.end}
      AND a."code" IN ('1000', '1010', '1020', '1090', '2200', '4000', '4100', '5000')
    GROUP BY 1, 2, 3`;
  const byMonth = new Map(range.months.map((m) => [m, { revenue: new D(0), creditNotes: new D(0), tax: new D(0), collected: new D(0), expenses: new D(0) }]));
  const CASH = new Set(["1000", "1010", "1020", "1090"]);
  for (const r of rows) {
    const b = byMonth.get(r.month);
    if (!b) continue;
    const debit = new D(r.debit);
    const credit = new D(r.credit);
    if (r.code === "4000") b.revenue = b.revenue.plus(credit).minus(debit);
    else if (r.code === "4100") b.creditNotes = b.creditNotes.plus(debit).minus(credit);
    else if (r.code === "2200") b.tax = b.tax.plus(credit).minus(debit);
    else if (r.code === "5000") b.expenses = b.expenses.plus(debit).minus(credit);
    else if (CASH.has(r.code)) {
      if (r.type === "payment.received") b.collected = b.collected.plus(debit);
      else if (r.type === "refund" || r.type === "payment.reversed") b.collected = b.collected.minus(credit);
    }
  }
  const months = range.months.map((month) => {
    const b = byMonth.get(month)!;
    return {
      month,
      revenue: b.revenue.toFixed(2),
      creditNotes: b.creditNotes.toFixed(2),
      netRevenue: b.revenue.minus(b.creditNotes).toFixed(2),
      tax: b.tax.toFixed(2),
      collected: b.collected.toFixed(2),
      expenses: b.expenses.toFixed(2),
    };
  });
  const sum = (k: keyof (typeof months)[number]) => months.reduce((a, m) => a.plus(m[k] as string), new D(0)).toFixed(2);
  return {
    currency: ctx.organization.currency,
    months,
    totals: { revenue: sum("revenue"), creditNotes: sum("creditNotes"), netRevenue: sum("netRevenue"), tax: sum("tax"), collected: sum("collected"), expenses: sum("expenses") },
  };
}

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;

export async function receivablesAging(ctx: StaffContext, now = new Date()) {
  requirePermission(ctx, "reports.read");
  const invoices = await db.invoice.findMany({
    where: { organizationId: ctx.organizationId, status: { in: ["OPEN", "PARTIALLY_PAID"] }, ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}) },
    select: { subscriberId: true, balanceDue: true, dueAt: true },
  });
  const subs = new Map<string, Record<(typeof AGING_BUCKETS)[number], InstanceType<typeof D>>>();
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, new D(0)])) as Record<(typeof AGING_BUCKETS)[number], InstanceType<typeof D>>;
  for (const inv of invoices) {
    const days = inv.dueAt ? Math.floor((now.getTime() - inv.dueAt.getTime()) / 86_400_000) : -1;
    const bucket: (typeof AGING_BUCKETS)[number] = days < 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
    if (!subs.has(inv.subscriberId)) subs.set(inv.subscriberId, Object.fromEntries(AGING_BUCKETS.map((b) => [b, new D(0)])) as Record<(typeof AGING_BUCKETS)[number], InstanceType<typeof D>>);
    const row = subs.get(inv.subscriberId)!;
    row[bucket] = row[bucket].plus(inv.balanceDue.toString());
    totals[bucket] = totals[bucket].plus(inv.balanceDue.toString());
  }
  const people = await db.subscriber.findMany({ where: { id: { in: [...subs.keys()] } }, select: { id: true, displayName: true, accountNumber: true, phone: true } });
  const rows = people
    .map((p) => {
      const b = subs.get(p.id)!;
      const total = AGING_BUCKETS.reduce((a, k) => a.plus(b[k]), new D(0));
      return { subscriberId: p.id, name: p.displayName, accountNumber: p.accountNumber, phone: p.phone, ...Object.fromEntries(AGING_BUCKETS.map((k) => [k, b[k].toFixed(2)])), total: total.toFixed(2) } as Record<string, string>;
    })
    .sort((a, b) => Number(b.total) - Number(a.total));
  const grand = AGING_BUCKETS.reduce((a, k) => a.plus(totals[k]), new D(0));
  return { currency: ctx.organization.currency, asOf: now.toISOString(), buckets: AGING_BUCKETS, rows, totals: { ...Object.fromEntries(AGING_BUCKETS.map((k) => [k, totals[k].toFixed(2)])), total: grand.toFixed(2) } };
}

export async function subscriberReport(ctx: StaffContext, q: z.infer<typeof reportRangeQuery>) {
  requirePermission(ctx, "reports.read");
  const tz = ctx.organization.timezone;
  const range = resolveMonthRange(tz, q.from, q.to);
  const [created, events, byPackage, byStatus] = await Promise.all([
    db.$queryRaw<Array<{ month: string; n: number }>>`
      SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE ${tz}), 'YYYY-MM') AS month, COUNT(*)::int AS n
      FROM "Subscriber" WHERE "organizationId" = ${ctx.organizationId}::uuid AND "createdAt" >= ${range.start} AND "createdAt" < ${range.end} GROUP BY 1`,
    db.$queryRaw<Array<{ month: string; type: string; n: number }>>`
      SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE ${tz}), 'YYYY-MM') AS month, "type", COUNT(*)::int AS n
      FROM "SubscriptionEvent" WHERE "organizationId" = ${ctx.organizationId}::uuid AND "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
        AND "type" IN ('activated', 'renewed', 'suspended', 'cancelled', 'expired') GROUP BY 1, 2`,
    db.subscription.groupBy({ by: ["packageName", "currency", "billingUnit", "billingCount", "price"], where: { organizationId: ctx.organizationId, status: "ACTIVE" }, _count: { _all: true } }),
    db.subscription.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId }, _count: { _all: true } }),
  ]);
  const months = range.months.map((month) => {
    const ev = (t: string) => events.find((e) => e.month === month && e.type === t)?.n ?? 0;
    return { month, newSubscribers: created.find((c) => c.month === month)?.n ?? 0, activated: ev("activated"), renewed: ev("renewed"), suspended: ev("suspended"), cancelled: ev("cancelled"), expired: ev("expired") };
  });
  const packages = new Map<string, { packageName: string; active: number; mrr: InstanceType<typeof D>; currency: string }>();
  for (const g of byPackage) {
    const cur = packages.get(g.packageName) ?? { packageName: g.packageName, active: 0, mrr: new D(0), currency: g.currency };
    cur.active += g._count._all;
    cur.mrr = cur.mrr.plus(monthlyEquivalent(new D(g.price.toString()), g.billingUnit, g.billingCount).mul(g._count._all));
    packages.set(g.packageName, cur);
  }
  return {
    months,
    byPackage: [...packages.values()].map((p) => ({ ...p, mrr: p.mrr.toFixed(2) })).sort((a, b) => b.active - a.active),
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
  };
}

export async function collectionsReport(ctx: StaffContext, q: z.infer<typeof reportRangeQuery>) {
  requirePermission(ctx, "reports.read");
  const tz = ctx.organization.timezone;
  const range = resolveMonthRange(tz, q.from, q.to);
  const rows = await db.$queryRaw<Array<{ month: string; method: string; n: number; amount: string }>>`
    SELECT to_char(date_trunc('month', "receivedAt" AT TIME ZONE ${tz}), 'YYYY-MM') AS month, "method"::text AS method, COUNT(*)::int AS n, COALESCE(SUM("amount"), 0)::text AS amount
    FROM "Payment"
    WHERE "organizationId" = ${ctx.organizationId}::uuid AND "status" = 'CONFIRMED' AND "receivedAt" >= ${range.start} AND "receivedAt" < ${range.end}
    GROUP BY 1, 2`;
  const methods = [...new Set(rows.map((r) => r.method))].sort();
  return {
    currency: ctx.organization.currency,
    methods,
    months: range.months.map((month) => ({
      month,
      ...Object.fromEntries(methods.map((m) => [m, rows.find((r) => r.month === month && r.method === m)?.amount ?? "0"])),
      total: rows.filter((r) => r.month === month).reduce((a, r) => a.plus(r.amount), new D(0)).toFixed(2),
      count: rows.filter((r) => r.month === month).reduce((a, r) => a + r.n, 0),
    })),
  };
}
