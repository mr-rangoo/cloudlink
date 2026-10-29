import { daysInMonth, fromWallTime, toWallTime } from "@/server/domain/time";

export type BillingUnit = "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR";

/**
 * Boundary `index` of a billing schedule anchored at `anchor`.
 * Boundary 0 is the anchor; period k spans [boundary(k), boundary(k+1)).
 *
 * Rules (documented in docs/BILLING.md):
 * - MINUTE / HOUR: exact elapsed time (short hotspot plans).
 * - DAY / WEEK: same local wall-clock time, N local days later (timezone-aware).
 * - MONTH / YEAR: same local day-of-month as the anchor, clamped to the last day of shorter months.
 *   Because every boundary is computed from the anchor (not from the previous boundary), a subscription
 *   anchored on 31 Jan bills on 28/29 Feb and returns to 31 Mar, and 29 Feb anchors return to 29 Feb in leap years.
 */
export function periodBoundary(anchor: Date, unit: BillingUnit, count: number, index: number, tz: string): Date {
  if (!Number.isInteger(count) || count < 1) throw new Error("billing count must be a positive integer");
  if (!Number.isInteger(index) || index < 0) throw new Error("period index must be a non-negative integer");
  if (index === 0) return new Date(anchor);
  const steps = count * index;

  if (unit === "MINUTE") return new Date(anchor.getTime() + steps * 60_000);
  if (unit === "HOUR") return new Date(anchor.getTime() + steps * 3_600_000);

  const w = toWallTime(anchor, tz);
  if (unit === "DAY" || unit === "WEEK") {
    const days = unit === "DAY" ? steps : steps * 7;
    const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
    return fromWallTime({ ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, tz);
  }

  const months = unit === "MONTH" ? steps : steps * 12;
  const total = w.year * 12 + (w.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(w.day, daysInMonth(year, month));
  return fromWallTime({ ...w, year, month, day }, tz);
}

export interface Period {
  index: number;
  start: Date;
  end: Date;
}

export function periodAt(anchor: Date, unit: BillingUnit, count: number, index: number, tz: string): Period {
  return { index, start: periodBoundary(anchor, unit, count, index, tz), end: periodBoundary(anchor, unit, count, index + 1, tz) };
}

/** Human label, e.g. "1 month", "3 months", "24 hours". */
export function describeInterval(unit: BillingUnit, count: number): string {
  const name = unit.toLowerCase();
  return `${count} ${name}${count === 1 ? "" : "s"}`;
}
