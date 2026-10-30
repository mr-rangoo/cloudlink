import { describe, expect, it } from "vitest";
import { availability, bucketSeries, healthScore, incidents, median, reachabilityHeatmap, type TelemetrySample } from "@/server/domain/router-telemetry";

const NOW = new Date("2026-10-30T09:00:00.000Z"); // 12:00 in Nairobi
const MIN = 60_000;

function sample(minutesAgo: number, over: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    takenAt: new Date(NOW.getTime() - minutesAgo * MIN),
    reachable: true,
    simulated: false,
    responseMs: 120,
    cpuLoad: 20,
    memoryUsedPct: 40,
    diskUsedPct: 30,
    temperatureC: 45,
    uptimeSeconds: 1000,
    rxBps: 20_000_000,
    txBps: 4_000_000,
    sessions: 12,
    ...over,
  };
}

describe("bucketSeries", () => {
  it("averages reachable samples per bucket and leaves empty buckets null", () => {
    const from = new Date(NOW.getTime() - 60 * MIN);
    const points = bucketSeries([sample(50, { cpuLoad: 10 }), sample(46, { cpuLoad: 30 }), sample(48, { reachable: false, cpuLoad: null }), sample(5)], from, NOW, 15 * MIN);
    expect(points).toHaveLength(5);
    expect(points[0]).toMatchObject({ checks: 3, cpu: 20, reachablePct: 66.7, rxMbps: 20, txMbps: 4 });
    expect(points[1]).toMatchObject({ checks: 0, cpu: null, reachablePct: null });
    expect(points[3]).toMatchObject({ checks: 1, cpu: 20, reachablePct: 100 });
  });
});

describe("availability and incidents", () => {
  it("measures the share of successful checks and groups consecutive failures", () => {
    const samples = [sample(30), sample(25, { reachable: false }), sample(20, { reachable: false }), sample(15), sample(10), sample(5, { reachable: false })];
    expect(availability(samples)).toBe(50);
    expect(availability([])).toBeNull();
    const list = incidents(samples, NOW);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ endedAt: null, failedChecks: 1, durationSeconds: 300 });
    expect(list[1]).toMatchObject({ failedChecks: 2, durationSeconds: 600 });
    expect(list[1]!.endedAt).toEqual(samples[3]!.takenAt);
  });
});

describe("reachabilityHeatmap", () => {
  it("places checks in local days and hours", () => {
    const days = reachabilityHeatmap([sample(0), sample(30, { reachable: false }), sample(24 * 60)], NOW, "Africa/Nairobi");
    expect(days).toHaveLength(7);
    expect(days[6]!.date).toBe("2026-10-30");
    expect(days[6]!.hours[12]).toBe(100);
    expect(days[6]!.hours[11]).toBe(0);
    expect(days[5]!.hours[12]).toBe(100);
    expect(days[0]!.hours.every((h) => h === null)).toBe(true);
  });
});

describe("healthScore", () => {
  it("scores a healthy router highly and explains each part", () => {
    const s = healthScore([sample(20), sample(10), sample(0)], NOW);
    expect(s).toMatchObject({ score: 100, grade: "good", cap: null });
    expect(s.parts.map((p) => p.key)).toEqual(["availability", "cpu", "memory", "storage", "response"]);
  });

  it("penalises load, slow responses and downtime", () => {
    const busy = healthScore([sample(10, { cpuLoad: 95, memoryUsedPct: 82.5, responseMs: 3000 }), sample(5, { reachable: false })], NOW);
    expect(busy.parts.find((p) => p.key === "cpu")!.points).toBe(0);
    expect(busy.parts.find((p) => p.key === "response")!.points).toBe(0);
    expect(busy.score).toBeLessThanOrEqual(25);
    expect(busy.cap).toMatch(/latest check/);
    expect(busy.grade).toBe("poor");
  });

  it("rescales when a router does not report a reading, and has no score without checks", () => {
    const s = healthScore([sample(5, { diskUsedPct: null, cpuLoad: null })], NOW);
    expect(s.parts.map((p) => p.key)).toEqual(["availability", "memory", "response"]);
    expect(s.score).toBe(100);
    expect(healthScore([], NOW)).toEqual({ score: null, grade: null, parts: [], cap: null });
  });

  it("median handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
