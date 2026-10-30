import { z } from "zod";
import { addLocalDays, fromWallTime, localDateKey, startOfLocalDay, toWallTime } from "@/server/domain/time";

/**
 * Reporting periods for lists (payments, expenses): calendar days in the organization timezone.
 * A period is [start, end): `end` is exclusive. "all" means no date filter.
 */
export const PERIODS = ["today", "yesterday", "7d", "30d", "month", "last_month", "custom", "all"] as const;
export type PeriodKey = (typeof PERIODS)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const periodFields = {
  period: z.enum(PERIODS).default("all"),
  /** Custom period, inclusive local dates. */
  from: day.optional(),
  to: day.optional(),
};

export interface ResolvedPeriod {
  key: PeriodKey;
  start: Date;
  end: Date;
  /** Inclusive local dates (YYYY-MM-DD), for display and exports. */
  fromDate: string;
  toDate: string;
}

function localDayStart(date: string, tz: string): Date {
  const [year, month, d] = date.split("-").map(Number) as [number, number, number];
  return fromWallTime({ year, month, day: d, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
}

/** Resolve a period to instants. Returns null for "all", or for a custom period without both dates. */
export function resolvePeriod(q: { period: PeriodKey; from?: string; to?: string }, tz: string, now = new Date()): ResolvedPeriod | null {
  const today = startOfLocalDay(now, tz);
  const tomorrow = addLocalDays(today, 1, tz);
  const make = (key: PeriodKey, start: Date, end: Date): ResolvedPeriod => ({ key, start, end, fromDate: localDateKey(start, tz), toDate: localDateKey(new Date(end.getTime() - 1), tz) });
  switch (q.period) {
    case "all":
      return null;
    case "today":
      return make("today", today, tomorrow);
    case "yesterday":
      return make("yesterday", addLocalDays(today, -1, tz), today);
    case "7d":
      return make("7d", addLocalDays(today, -6, tz), tomorrow);
    case "30d":
      return make("30d", addLocalDays(today, -29, tz), tomorrow);
    case "month": {
      const w = toWallTime(now, tz);
      return make("month", fromWallTime({ year: w.year, month: w.month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz), tomorrow);
    }
    case "last_month": {
      const w = toWallTime(now, tz);
      const thisMonth = fromWallTime({ year: w.year, month: w.month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
      const prev = w.month === 1 ? { year: w.year - 1, month: 12 } : { year: w.year, month: w.month - 1 };
      return make("last_month", fromWallTime({ ...prev, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz), thisMonth);
    }
    case "custom": {
      if (!q.from || !q.to) return null;
      const [a, b] = q.from <= q.to ? [q.from, q.to] : [q.to, q.from];
      return make("custom", localDayStart(a, tz), addLocalDays(localDayStart(b, tz), 1, tz));
    }
  }
}

/** The equally long period just before (for "vs previous period" comparisons). */
export function previousPeriod(p: ResolvedPeriod, tz: string): ResolvedPeriod {
  const length = p.end.getTime() - p.start.getTime();
  const start = new Date(p.start.getTime() - length);
  return { key: p.key, start, end: p.start, fromDate: localDateKey(start, tz), toDate: localDateKey(new Date(p.start.getTime() - 1), tz) };
}

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  last_month: "Last month",
  custom: "Custom dates",
  all: "All time",
};
