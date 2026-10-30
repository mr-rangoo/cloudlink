import { describe, expect, it } from "vitest";
import { previousPeriod, resolvePeriod } from "@/server/domain/periods";

const TZ = "Africa/Nairobi"; // UTC+3, no daylight saving
const NOW = new Date("2026-03-01T01:30:00.000Z"); // 04:30 on Sunday 1 March in Nairobi

describe("resolvePeriod", () => {
  it("uses local calendar days", () => {
    expect(resolvePeriod({ period: "today" }, TZ, NOW)).toMatchObject({ start: new Date("2026-02-28T21:00:00.000Z"), end: new Date("2026-03-01T21:00:00.000Z"), fromDate: "2026-03-01", toDate: "2026-03-01" });
    expect(resolvePeriod({ period: "yesterday" }, TZ, NOW)).toMatchObject({ fromDate: "2026-02-28", toDate: "2026-02-28" });
    expect(resolvePeriod({ period: "7d" }, TZ, NOW)).toMatchObject({ fromDate: "2026-02-23", toDate: "2026-03-01" });
    expect(resolvePeriod({ period: "30d" }, TZ, NOW)).toMatchObject({ fromDate: "2026-01-31", toDate: "2026-03-01" });
  });

  it("handles months, including the year boundary", () => {
    expect(resolvePeriod({ period: "month" }, TZ, NOW)).toMatchObject({ fromDate: "2026-03-01", toDate: "2026-03-01" });
    expect(resolvePeriod({ period: "last_month" }, TZ, NOW)).toMatchObject({ fromDate: "2026-02-01", toDate: "2026-02-28", end: new Date("2026-02-28T21:00:00.000Z") });
    expect(resolvePeriod({ period: "last_month" }, TZ, new Date("2026-01-10T09:00:00Z"))).toMatchObject({ fromDate: "2025-12-01", toDate: "2025-12-31" });
  });

  it("custom ranges are inclusive, order-insensitive, and need both dates", () => {
    expect(resolvePeriod({ period: "custom", from: "2026-02-10", to: "2026-02-12" }, TZ, NOW)).toMatchObject({ start: new Date("2026-02-09T21:00:00.000Z"), end: new Date("2026-02-12T21:00:00.000Z"), fromDate: "2026-02-10", toDate: "2026-02-12" });
    expect(resolvePeriod({ period: "custom", from: "2026-02-12", to: "2026-02-10" }, TZ, NOW)).toMatchObject({ fromDate: "2026-02-10", toDate: "2026-02-12" });
    expect(resolvePeriod({ period: "custom", from: "2026-02-10" }, TZ, NOW)).toBeNull();
    expect(resolvePeriod({ period: "all" }, TZ, NOW)).toBeNull();
  });

  it("the previous period has the same length and ends where this one starts", () => {
    const p = resolvePeriod({ period: "7d" }, TZ, NOW)!;
    const prev = previousPeriod(p, TZ);
    expect(prev.end).toEqual(p.start);
    expect(prev.end.getTime() - prev.start.getTime()).toBe(p.end.getTime() - p.start.getTime());
    expect(prev).toMatchObject({ fromDate: "2026-02-16", toDate: "2026-02-22" });
  });
});
