import { describe, expect, it } from "vitest";
import {
  availabilityOf,
  burstProblem,
  defaultProfileName,
  describeSchedule,
  durationLabel,
  durationShort,
  formatRate,
  formatRatePair,
  parseDurationKey,
  parseHHMM,
  parseRate,
  parseRatePair,
  planTypeFields,
  planTypeOf,
  quotaLabel,
  routerRateLimit,
  scheduleOpen,
} from "@/lib/plans";
import { periodBoundary } from "@/server/domain/billing-period";
import { normalizeRateLimit } from "@/server/integrations/network";

describe("rates", () => {
  it("parses RouterOS-style rates into kbps (decimal units)", () => {
    expect(parseRate("512k")).toBe(512);
    expect(parseRate("5M")).toBe(5000);
    expect(parseRate("1.5M")).toBe(1500);
    expect(parseRate("1G")).toBe(1_000_000);
    expect(parseRate(" 10m ")).toBe(10_000);
    for (const bad of ["", "5", "5 Mbps", "-1M", "0k", "M", "5MM", "200G"]) expect(parseRate(bad), bad).toBeNull();
  });

  it("formats kbps the way RouterOS accepts (integers with a unit)", () => {
    expect(formatRate(5000)).toBe("5M");
    expect(formatRate(1500)).toBe("1500k");
    expect(formatRate(512)).toBe("512k");
    expect(formatRate(2_000_000)).toBe("2G");
  });

  it("reads upload first, then download", () => {
    expect(parseRatePair("2M/10M")).toEqual({ upKbps: 2000, downKbps: 10000 });
    expect(parseRatePair("5M")).toEqual({ upKbps: 5000, downKbps: 5000 });
    expect(parseRatePair("2M/10M/1M")).toBeNull();
    expect(parseRatePair("/5M")).toBeNull();
    expect(formatRatePair(2000, 10000)).toBe("2M/10M");
    expect(formatRatePair(null, 10000)).toBe("");
  });

  it("builds the MikroTik rate-limit with burst only when every burst value is set", () => {
    const base = { uploadKbps: 5000, downloadKbps: 5000 };
    expect(routerRateLimit(base)).toBe("5M/5M");
    expect(routerRateLimit({ uploadKbps: null, downloadKbps: 5000 })).toBeNull();
    const burst = { ...base, burstUploadKbps: 10000, burstDownloadKbps: 10000, burstThresholdUploadKbps: 4000, burstThresholdDownloadKbps: 4000, burstTimeSeconds: 30 };
    expect(routerRateLimit(burst)).toBe("5M/5M 10M/10M 4M/4M 30/30");
    expect(routerRateLimit({ ...burst, burstTimeSeconds: null })).toBe("5M/5M");
  });

  it("rejects burst settings MikroTik would never trigger", () => {
    const base = { uploadKbps: 5000, downloadKbps: 5000, burstThresholdUploadKbps: 4000, burstThresholdDownloadKbps: 4000, burstTimeSeconds: 30 };
    expect(burstProblem({ ...base, burstUploadKbps: 10000, burstDownloadKbps: 10000 })).toBeNull();
    expect(burstProblem({ ...base, burstUploadKbps: 5000, burstDownloadKbps: 10000 })).toMatch(/higher than the rate limit/);
    expect(burstProblem({ ...base, burstUploadKbps: 10000, burstDownloadKbps: 10000, burstThresholdDownloadKbps: 6000 })).toMatch(/lower than the rate limit/);
  });

  it("compares limits the router prints with a time unit", () => {
    expect(normalizeRateLimit("5M/5M 10M/10M 4M/4M 30s/30s")).toBe(normalizeRateLimit("5M/5M 10M/10M 4M/4M 30/30"));
    expect(normalizeRateLimit(" 5M/5M ")).toBe("5M/5M");
  });
});

describe("durations and data", () => {
  it("labels durations", () => {
    expect(durationLabel("MINUTE", 30)).toBe("30 minutes");
    expect(durationLabel("HOUR", 1)).toBe("1 hour");
    expect(durationShort("DAY", 7)).toBe("7d");
    expect(parseDurationKey("3:HOUR")).toEqual({ unit: "HOUR", count: 3 });
    expect(parseDurationKey("0:HOUR")).toBeNull();
    expect(parseDurationKey("1:FORTNIGHT")).toBeNull();
  });

  it("adds minute periods as exact elapsed time", () => {
    const anchor = new Date("2026-10-30T20:50:00Z");
    expect(periodBoundary(anchor, "MINUTE", 30, 1, "Africa/Nairobi").toISOString()).toBe("2026-10-30T21:20:00.000Z");
    expect(periodBoundary(anchor, "MINUTE", 30, 3, "Africa/Nairobi").toISOString()).toBe("2026-10-30T22:20:00.000Z");
  });

  it("labels data allowances", () => {
    expect(quotaLabel(1024)).toBe("1 GB");
    expect(quotaLabel(1536)).toBe("1.5 GB");
    expect(quotaLabel(500)).toBe("500 MB");
  });
});

describe("schedules", () => {
  const night = { scheduleEnabled: true, scheduleStartMinute: 23 * 60, scheduleEndMinute: 6 * 60, scheduleDays: null };
  it("handles windows that cross midnight", () => {
    expect(scheduleOpen(night, { weekday: 0, minute: 23 * 60 + 30 })).toBe(true);
    expect(scheduleOpen(night, { weekday: 1, minute: 5 * 60 })).toBe(true);
    expect(scheduleOpen(night, { weekday: 1, minute: 6 * 60 })).toBe(false);
    expect(scheduleOpen(night, { weekday: 1, minute: 12 * 60 })).toBe(false);
  });

  it("counts the early hours toward the day the window started", () => {
    const fridayNights = { ...night, scheduleDays: 1 << 4 }; // Friday
    expect(scheduleOpen(fridayNights, { weekday: 4, minute: 23 * 60 + 5 })).toBe(true); // Friday 23:05
    expect(scheduleOpen(fridayNights, { weekday: 5, minute: 2 * 60 })).toBe(true); // Saturday 02:00
    expect(scheduleOpen(fridayNights, { weekday: 5, minute: 23 * 60 + 5 })).toBe(false); // Saturday 23:05
    expect(scheduleOpen(fridayNights, { weekday: 0, minute: 2 * 60 })).toBe(false); // Monday 02:00 (Sunday night)
  });

  it("handles same-day windows, Sunday wrap-around and disabled schedules", () => {
    const office = { scheduleEnabled: true, scheduleStartMinute: 8 * 60, scheduleEndMinute: 17 * 60, scheduleDays: 0b0011111 };
    expect(scheduleOpen(office, { weekday: 2, minute: 9 * 60 })).toBe(true);
    expect(scheduleOpen(office, { weekday: 5, minute: 9 * 60 })).toBe(false);
    const sundayNight = { ...night, scheduleDays: 1 << 6 };
    expect(scheduleOpen(sundayNight, { weekday: 0, minute: 60 })).toBe(true); // Monday 01:00 belongs to Sunday's window
    expect(scheduleOpen({ ...office, scheduleEnabled: false }, { weekday: 5, minute: 0 })).toBe(true);
    expect(describeSchedule(night)).toBe("23:00–06:00 daily");
    expect(describeSchedule(office)).toBe("08:00–17:00 Mon, Tue, Wed, Thu, Fri");
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM("24:00")).toBeNull();
  });
});

describe("plan types and names", () => {
  it("maps operator plan types to stored fields and back", () => {
    for (const t of ["HOTSPOT", "PPPOE", "DATA", "TRIAL", "DEVICE", "STATIC_IP"] as const) {
      const f = planTypeFields(t);
      expect(planTypeOf(f.serviceType, f.kind)).toBe(t);
    }
    expect(planTypeFields("DATA")).toEqual({ serviceType: "HOTSPOT", kind: "DATA" });
  });

  it("derives availability and profile names", () => {
    expect(availabilityOf("ACTIVE", true)).toBe("LIVE");
    expect(availabilityOf("ACTIVE", false)).toBe("HIDDEN");
    expect(availabilityOf("INACTIVE", true)).toBe("OFF");
    expect(availabilityOf("ARCHIVED", true)).toBe("ARCHIVED");
    expect(defaultProfileName("Fast 1 hour @10/=")).toBe("cl-fast-1-hour-10");
    expect(defaultProfileName("***")).toBe("cl-plan");
  });
});
