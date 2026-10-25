/**
 * Timezone-aware calendar math without external dependencies.
 * Instants are JS Dates (UTC); "wall time" is the local calendar time in an IANA zone.
 */
export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function toWallTime(date: Date, tz: string): WallTime {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    millisecond: date.getUTCMilliseconds(),
  };
}

function wallAsUtcMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
}

/** Offset (ms) of `tz` from UTC at the given instant. */
export function tzOffsetMs(date: Date, tz: string): number {
  // toWallTime carries the instant's milliseconds, so the difference is exactly the zone offset.
  return wallAsUtcMs(toWallTime(date, tz)) - date.getTime();
}

/** Convert a local wall time in `tz` to an instant. Resolves DST gaps by moving forward. */
export function fromWallTime(w: WallTime, tz: string): Date {
  const naive = wallAsUtcMs(w);
  let guess = naive - tzOffsetMs(new Date(naive), tz);
  // Two refinement passes handle zones whose offset differs between the naive guess and the result.
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMs(new Date(guess), tz);
    guess = naive - offset;
  }
  return new Date(guess);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Start of the local day in `tz` for the given instant. */
export function startOfLocalDay(date: Date, tz: string): Date {
  const w = toWallTime(date, tz);
  return fromWallTime({ ...w, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
}

export function addLocalDays(date: Date, days: number, tz: string): Date {
  const w = toWallTime(date, tz);
  const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return fromWallTime({ ...w, year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }, tz);
}

/** Local YYYY-MM-DD for display/keys. */
export function localDateKey(date: Date, tz: string): string {
  const w = toWallTime(date, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Last millisecond of the local calendar day in `tz` containing the instant (due dates are whole days). */
export function endOfLocalDay(date: Date, tz: string): Date {
  return new Date(addLocalDays(startOfLocalDay(date, tz), 1, tz).getTime() - 1);
}
