// Plan (package) helpers shared by the plan form, list pages and the server. No React or server imports here.

/**
 * Rates are stored as integer kbps. Units follow RouterOS: k = 1 000 bit/s, M = 1 000 000, G = 1 000 000 000.
 * MikroTik writes "upload/download" from the router's point of view (rx/tx), so "2M/10M" is 2 Mbps up, 10 Mbps down.
 */
const RATE_RE = /^(\d{1,7}(?:\.\d{1,3})?)\s*([kKmMgG])$/;
const UNIT_KBPS: Record<string, number> = { k: 1, m: 1_000, g: 1_000_000 };
export const MAX_RATE_KBPS = 100_000_000; // 100 Gbps

export function parseRate(input: string): number | null {
  const m = RATE_RE.exec(input.trim());
  if (!m) return null;
  const kbps = Math.round(Number(m[1]) * UNIT_KBPS[m[2]!.toLowerCase()]!);
  return kbps >= 1 && kbps <= MAX_RATE_KBPS ? kbps : null;
}

export function formatRate(kbps: number): string {
  if (kbps >= 1_000_000 && kbps % 1_000_000 === 0) return `${kbps / 1_000_000}G`;
  if (kbps >= 1_000 && kbps % 1_000 === 0) return `${kbps / 1_000}M`;
  return `${kbps}k`; // RouterOS takes integers with a unit, so 1.5 Mbps is written 1500k
}

/** "2M/10M" → 2 Mbps up, 10 Mbps down. A single value ("5M") applies to both directions. */
export function parseRatePair(input: string): { upKbps: number; downKbps: number } | null {
  const parts = input.trim().split("/");
  if (parts.length > 2 || !parts[0]) return null;
  const up = parseRate(parts[0]);
  const down = parseRate(parts[1] ?? parts[0]);
  return up && down ? { upKbps: up, downKbps: down } : null;
}

export function formatRatePair(upKbps: number | null | undefined, downKbps: number | null | undefined): string {
  if (!upKbps || !downKbps) return "";
  return `${formatRate(upKbps)}/${formatRate(downKbps)}`;
}

export interface RateSpec {
  uploadKbps: number | null;
  downloadKbps: number | null;
  burstUploadKbps?: number | null;
  burstDownloadKbps?: number | null;
  burstThresholdUploadKbps?: number | null;
  burstThresholdDownloadKbps?: number | null;
  burstTimeSeconds?: number | null;
}

export function hasBurst(p: RateSpec): boolean {
  return Boolean(p.burstUploadKbps && p.burstDownloadKbps && p.burstThresholdUploadKbps && p.burstThresholdDownloadKbps && p.burstTimeSeconds);
}

/**
 * RouterOS `rate-limit` value: "rx/tx [burst-rx/burst-tx threshold-rx/threshold-tx time-rx/time-tx]".
 * Null when the plan has no speed limit (the router profile then keeps whatever limit it has).
 */
export function routerRateLimit(p: RateSpec): string | null {
  if (!p.uploadKbps || !p.downloadKbps) return null;
  const base = formatRatePair(p.uploadKbps, p.downloadKbps);
  if (!hasBurst(p)) return base;
  const t = p.burstTimeSeconds!;
  return `${base} ${formatRatePair(p.burstUploadKbps, p.burstDownloadKbps)} ${formatRatePair(p.burstThresholdUploadKbps, p.burstThresholdDownloadKbps)} ${t}/${t}`;
}

/** MikroTik burst only works when burst-limit > rate-limit > burst-threshold. Returns a message, or null when valid. */
export function burstProblem(p: RateSpec): string | null {
  if (!hasBurst(p)) return null;
  if (!p.uploadKbps || !p.downloadKbps) return "Set the rate limit before adding burst.";
  if (p.burstUploadKbps! <= p.uploadKbps || p.burstDownloadKbps! <= p.downloadKbps) return "The burst limit must be higher than the rate limit in both directions.";
  if (p.burstThresholdUploadKbps! >= p.uploadKbps || p.burstThresholdDownloadKbps! >= p.downloadKbps) return "The burst threshold must be lower than the rate limit in both directions.";
  return null;
}

// ───────── Durations ─────────

export type DurationUnit = "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR";

export const DURATION_PRESETS: Array<{ unit: DurationUnit; count: number }> = [
  { unit: "MINUTE", count: 15 },
  { unit: "MINUTE", count: 30 },
  { unit: "HOUR", count: 1 },
  { unit: "HOUR", count: 2 },
  { unit: "HOUR", count: 3 },
  { unit: "HOUR", count: 4 },
  { unit: "HOUR", count: 5 },
  { unit: "HOUR", count: 6 },
  { unit: "HOUR", count: 8 },
  { unit: "HOUR", count: 12 },
  { unit: "DAY", count: 1 },
  { unit: "DAY", count: 2 },
  { unit: "DAY", count: 3 },
  { unit: "WEEK", count: 1 },
  { unit: "WEEK", count: 2 },
  { unit: "MONTH", count: 1 },
  { unit: "MONTH", count: 3 },
  { unit: "MONTH", count: 6 },
  { unit: "YEAR", count: 1 },
];

const UNIT_WORD: Record<DurationUnit, [string, string]> = {
  MINUTE: ["minute", "minutes"],
  HOUR: ["hour", "hours"],
  DAY: ["day", "days"],
  WEEK: ["week", "weeks"],
  MONTH: ["month", "months"],
  YEAR: ["year", "years"],
};
const UNIT_SHORT: Record<DurationUnit, string> = { MINUTE: "min", HOUR: "h", DAY: "d", WEEK: "w", MONTH: "mo", YEAR: "y" };

/** "30 minutes", "1 hour", "7 days". */
export function durationLabel(unit: DurationUnit, count: number): string {
  const [one, many] = UNIT_WORD[unit];
  return `${count} ${count === 1 ? one : many}`;
}

/** Compact form for tables: "30min", "1h", "7d", "1mo". */
export function durationShort(unit: DurationUnit, count: number): string {
  return `${count}${UNIT_SHORT[unit]}`;
}

export function durationKey(unit: DurationUnit, count: number): string {
  return `${count}:${unit}`;
}

export function parseDurationKey(key: string): { unit: DurationUnit; count: number } | null {
  const m = /^(\d{1,3}):(MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)$/.exec(key);
  if (!m) return null;
  const count = Number(m[1]);
  return count >= 1 ? { unit: m[2] as DurationUnit, count } : null;
}

// ───────── Data ─────────

export function quotaLabel(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`;
  if (mb >= 1024) return `${(mb / 1024).toLocaleString("en-KE", { maximumFractionDigits: 2 })} GB`;
  return `${mb} MB`;
}

// ───────── Schedule ─────────

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const ALL_DAYS = 0b111_1111;

export function minuteToHHMM(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function parseHHMM(input: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export interface ScheduleSpec {
  scheduleEnabled: boolean;
  scheduleStartMinute: number | null;
  scheduleEndMinute: number | null;
  scheduleDays: number | null;
}

/**
 * Whether a scheduled plan may be used at a local moment (weekday 0 = Monday, minute after local midnight).
 * The window [start, end) may cross midnight (e.g. 23:00–06:00); days name the day the window starts on.
 */
export function scheduleOpen(s: ScheduleSpec, local: { weekday: number; minute: number }): boolean {
  if (!s.scheduleEnabled || s.scheduleStartMinute === null || s.scheduleEndMinute === null) return true;
  const days = s.scheduleDays ?? ALL_DAYS;
  const dayOn = (d: number) => (days & (1 << ((d + 7) % 7))) !== 0;
  const { scheduleStartMinute: start, scheduleEndMinute: end } = s;
  if (start < end) return dayOn(local.weekday) && local.minute >= start && local.minute < end;
  return (dayOn(local.weekday) && local.minute >= start) || (dayOn(local.weekday - 1) && local.minute < end);
}

export function describeSchedule(s: ScheduleSpec): string | null {
  if (!s.scheduleEnabled || s.scheduleStartMinute === null || s.scheduleEndMinute === null) return null;
  const days = s.scheduleDays ?? ALL_DAYS;
  const which = days === ALL_DAYS ? "daily" : DAY_LABELS.filter((_, i) => days & (1 << i)).join(", ");
  return `${minuteToHHMM(s.scheduleStartMinute)}–${minuteToHHMM(s.scheduleEndMinute)} ${which}`;
}

// ───────── Labels ─────────

export type PlanKind = "TIME" | "DATA" | "TRIAL" | "DEVICE";
export type Availability = "LIVE" | "HIDDEN" | "OFF" | "ARCHIVED";

export function availabilityOf(status: string, listed: boolean): Availability {
  if (status === "ARCHIVED") return "ARCHIVED";
  if (status !== "ACTIVE") return "OFF";
  return listed ? "LIVE" : "HIDDEN";
}

export const AVAILABILITY_LABEL: Record<Availability, string> = { LIVE: "Live", HIDDEN: "Hidden", OFF: "Off", ARCHIVED: "Archived" };
export const AVAILABILITY_HINT: Record<Exclude<Availability, "ARCHIVED">, string> = {
  LIVE: "Customers can see and buy it.",
  HIDDEN: "Not shown to customers. Staff can still assign it.",
  OFF: "Cannot be sold or assigned. Existing subscriptions keep their terms.",
};

/** Plan type as operators think of it: access technology plus what the plan grants. */
export type PlanType = "HOTSPOT" | "PPPOE" | "DATA" | "TRIAL" | "DEVICE" | "STATIC_IP" | "OTHER";

export function planTypeOf(serviceType: string, kind: string): PlanType {
  if (kind === "DATA") return "DATA";
  if (kind === "TRIAL") return "TRIAL";
  if (kind === "DEVICE") return "DEVICE";
  return serviceType === "PPPOE" || serviceType === "HOTSPOT" || serviceType === "STATIC_IP" ? serviceType : "OTHER";
}

export const PLAN_TYPE_LABEL: Record<PlanType, string> = {
  HOTSPOT: "Hotspot",
  PPPOE: "PPPoE",
  DATA: "Data bundle",
  TRIAL: "Trial",
  DEVICE: "TV / device",
  STATIC_IP: "Static IP",
  OTHER: "Other",
};

/** Plan type → stored (serviceType, kind). Data bundles, trials and devices are sold over the hotspot. */
export function planTypeFields(t: PlanType): { serviceType: "PPPOE" | "HOTSPOT" | "STATIC_IP" | "OTHER"; kind: PlanKind } {
  switch (t) {
    case "PPPOE":
      return { serviceType: "PPPOE", kind: "TIME" };
    case "DATA":
      return { serviceType: "HOTSPOT", kind: "DATA" };
    case "TRIAL":
      return { serviceType: "HOTSPOT", kind: "TRIAL" };
    case "DEVICE":
      return { serviceType: "HOTSPOT", kind: "DEVICE" };
    case "STATIC_IP":
      return { serviceType: "STATIC_IP", kind: "TIME" };
    case "OTHER":
      return { serviceType: "OTHER", kind: "TIME" };
    default:
      return { serviceType: "HOTSPOT", kind: "TIME" };
  }
}

export const HIGHLIGHT_LABEL: Record<string, string> = { POPULAR: "Popular", OFFER: "On offer" };

/** Stable router profile name for a new plan: lower-case words joined by dashes, prefixed so it is recognisable on the router. */
export function defaultProfileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `cl-${slug || "plan"}`;
}
