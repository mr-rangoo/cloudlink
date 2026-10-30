import { localDateKey, startOfLocalDay, addLocalDays, toWallTime } from "@/server/domain/time";

/**
 * Router telemetry math: chart series, availability, the reachability heatmap, outage incidents and the health score.
 * Pure functions over health-check samples (one sample per check, normally every five minutes).
 */
export interface TelemetrySample {
  takenAt: Date;
  reachable: boolean;
  simulated: boolean;
  responseMs: number | null;
  cpuLoad: number | null;
  memoryUsedPct: number | null;
  diskUsedPct: number | null;
  temperatureC: number | null;
  uptimeSeconds: number | null;
  rxBps: number | null;
  txBps: number | null;
  sessions: number | null;
}

export interface SeriesPoint {
  /** Bucket start (epoch ms). */
  t: number;
  checks: number;
  /** Share of checks in the bucket that reached the router (0–100); null = no checks. */
  reachablePct: number | null;
  cpu: number | null;
  memory: number | null;
  temperature: number | null;
  rxMbps: number | null;
  txMbps: number | null;
  responseMs: number | null;
  sessions: number | null;
}

const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function mean(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Average samples into fixed buckets from `from` to `to`. Empty buckets stay null so charts show a gap. */
export function bucketSeries(samples: TelemetrySample[], from: Date, to: Date, bucketMs: number): SeriesPoint[] {
  const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
  const groups = new Map<number, TelemetrySample[]>();
  for (const s of samples) {
    const t = s.takenAt.getTime();
    if (t < start || t > to.getTime()) continue;
    const key = Math.floor(t / bucketMs) * bucketMs;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  const out: SeriesPoint[] = [];
  for (let t = start; t <= to.getTime(); t += bucketMs) {
    const g = groups.get(t) ?? [];
    const up = g.filter((s) => s.reachable);
    const avg = (pick: (s: TelemetrySample) => number | null, digits = 0, scale = 1) => {
      const m = mean(up.map(pick));
      return m === null ? null : round(m / scale, digits);
    };
    out.push({
      t,
      checks: g.length,
      reachablePct: g.length ? round((up.length / g.length) * 100, 1) : null,
      cpu: avg((s) => s.cpuLoad),
      memory: avg((s) => s.memoryUsedPct),
      temperature: avg((s) => s.temperatureC, 1),
      rxMbps: avg((s) => s.rxBps, 2, 1_000_000),
      txMbps: avg((s) => s.txBps, 2, 1_000_000),
      responseMs: avg((s) => s.responseMs),
      sessions: avg((s) => s.sessions),
    });
  }
  return out;
}

/** Share of checks that reached the router (0–100, one decimal); null when there were no checks. */
export function availability(samples: TelemetrySample[]): number | null {
  if (!samples.length) return null;
  return round((samples.filter((s) => s.reachable).length / samples.length) * 100, 1);
}

export interface HeatmapDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** Share of checks that reached the router in each local hour (0–100); null = no checks that hour. */
  hours: Array<number | null>;
}

/** Reachability by local day and hour for the last `days` days (oldest first). */
export function reachabilityHeatmap(samples: TelemetrySample[], now: Date, tz: string, days = 7): HeatmapDay[] {
  const first = addLocalDays(startOfLocalDay(now, tz), -(days - 1), tz);
  const cells = new Map<string, { up: number; total: number }>();
  for (const s of samples) {
    if (s.takenAt < first || s.takenAt > now) continue;
    const key = `${localDateKey(s.takenAt, tz)}:${toWallTime(s.takenAt, tz).hour}`;
    const c = cells.get(key) ?? { up: 0, total: 0 };
    c.total++;
    if (s.reachable) c.up++;
    cells.set(key, c);
  }
  const out: HeatmapDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = localDateKey(addLocalDays(first, i, tz), tz);
    out.push({
      date,
      hours: Array.from({ length: 24 }, (_, h) => {
        const c = cells.get(`${date}:${h}`);
        return c ? round((c.up / c.total) * 100, 1) : null;
      }),
    });
  }
  return out;
}

export interface Incident {
  /** First failed check. */
  startedAt: Date;
  /** First successful check afterwards; null while the router is still unreachable. */
  endedAt: Date | null;
  durationSeconds: number;
  failedChecks: number;
}

/** Runs of consecutive failed checks, newest first. Durations are measured between checks, so they are approximate. */
export function incidents(samples: TelemetrySample[], now: Date, limit = 20): Incident[] {
  const sorted = [...samples].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const out: Incident[] = [];
  let open: { startedAt: Date; failedChecks: number } | null = null;
  for (const s of sorted) {
    if (!s.reachable) {
      if (open) open.failedChecks++;
      else open = { startedAt: s.takenAt, failedChecks: 1 };
    } else if (open) {
      out.push({ ...open, endedAt: s.takenAt, durationSeconds: Math.round((s.takenAt.getTime() - open.startedAt.getTime()) / 1000) });
      open = null;
    }
  }
  if (open) out.push({ ...open, endedAt: null, durationSeconds: Math.round((now.getTime() - open.startedAt.getTime()) / 1000) });
  return out.reverse().slice(0, limit);
}

export interface ScorePart {
  key: "availability" | "cpu" | "memory" | "storage" | "response";
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface HealthScore {
  /** 0–100; null when there are no checks in the last 24 hours. */
  score: number | null;
  grade: "good" | "fair" | "poor" | null;
  parts: ScorePart[];
  /** Why the score was capped, if it was. */
  cap: string | null;
}

/** Full points at or below `good`, none at or above `bad`, linear in between. */
const linear = (value: number, good: number, bad: number) => (value <= good ? 1 : value >= bad ? 0 : (bad - value) / (bad - good));

/**
 * Health score from the last 24 hours of checks:
 * availability 50 points (share of successful checks), CPU 10 (average of the last hour; full ≤70 %, none ≥95 %),
 * memory 10 and storage 10 (latest reading; same thresholds), API response 20 (median; full ≤300 ms, none ≥3 s).
 * Readings a router does not report are left out and the score is rescaled. Unreachable right now → at most 25.
 */
export function healthScore(samples24h: TelemetrySample[], now: Date): HealthScore {
  if (!samples24h.length) return { score: null, grade: null, parts: [], cap: null };
  const sorted = [...samples24h].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const up = sorted.filter((s) => s.reachable);
  const latest = sorted[sorted.length - 1]!;
  const latestUp = up[up.length - 1];
  const parts: ScorePart[] = [];
  const avail = availability(sorted)!;
  parts.push({ key: "availability", label: "Availability", max: 50, points: round((avail / 100) * 50, 1), detail: `${avail}% of ${sorted.length} checks reached the router` });

  const lastHour = up.filter((s) => s.takenAt.getTime() >= now.getTime() - 3_600_000);
  const cpu = mean(lastHour.map((s) => s.cpuLoad));
  if (cpu !== null) parts.push({ key: "cpu", label: "CPU", max: 10, points: round(10 * linear(cpu, 70, 95), 1), detail: `${round(cpu)}% average over the last hour` });
  if (latestUp?.memoryUsedPct != null) parts.push({ key: "memory", label: "Memory", max: 10, points: round(10 * linear(latestUp.memoryUsedPct, 70, 95), 1), detail: `${latestUp.memoryUsedPct}% used` });
  if (latestUp?.diskUsedPct != null) parts.push({ key: "storage", label: "Storage", max: 10, points: round(10 * linear(latestUp.diskUsedPct, 70, 95), 1), detail: `${latestUp.diskUsedPct}% used` });
  const response = median(up.map((s) => s.responseMs).filter((v): v is number => v !== null));
  if (response !== null) parts.push({ key: "response", label: "API response", max: 20, points: round(20 * linear(response, 300, 3000), 1), detail: `${round(response)} ms median` });

  const max = parts.reduce((a, p) => a + p.max, 0);
  let score = Math.round((parts.reduce((a, p) => a + p.points, 0) / max) * 100);
  let cap: string | null = null;
  if (!latest.reachable && score > 25) {
    score = 25;
    cap = "The latest check could not reach the router";
  }
  return { score, grade: score >= 85 ? "good" : score >= 60 ? "fair" : "poor", parts, cap };
}
