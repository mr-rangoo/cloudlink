import { describe, expect, it } from "vitest";
import { periodBoundary, periodAt } from "@/server/domain/billing-period";
import { fromWallTime, toWallTime, localDateKey } from "@/server/domain/time";
import { allowedActions, nextStatus, renewalContinues } from "@/server/domain/subscription-state";
import { formatPhone, normalizePhone } from "@/server/domain/contact";
import { moneyInput, moneyString, positiveMoneyInput, sumMoney, D } from "@/server/domain/money";
import { csvCell, CsvError, parseCsv } from "@/server/domain/csv";

const NBO = "Africa/Nairobi";
const nairobi = (y: number, m: number, d: number, h = 0, mi = 0) => fromWallTime({ year: y, month: m, day: d, hour: h, minute: mi, second: 0, millisecond: 0 }, NBO);
const key = (d: Date) => localDateKey(d, NBO);

describe("timezone helpers", () => {
  it("converts Nairobi wall time to UTC (+03:00, no DST)", () => {
    expect(nairobi(2026, 1, 1).toISOString()).toBe("2025-12-31T21:00:00.000Z");
    expect(toWallTime(new Date("2026-06-30T21:30:00Z"), NBO)).toMatchObject({ year: 2026, month: 7, day: 1, hour: 0, minute: 30 });
  });

  it("handles DST zones (wall time preserved across a DST change)", () => {
    const before = fromWallTime({ year: 2026, month: 3, day: 7, hour: 9, minute: 0, second: 0, millisecond: 0 }, "America/New_York");
    const after = periodBoundary(before, "DAY", 2, 1, "America/New_York");
    expect(toWallTime(after, "America/New_York")).toMatchObject({ day: 9, hour: 9 });
    expect(after.getTime() - before.getTime()).toBe(47 * 3600_000); // 23-hour day on 8 March
  });
});

describe("billing periods", () => {
  it("monthly periods clamp month-end and return to the anchor day", () => {
    const anchor = nairobi(2027, 1, 31, 10);
    expect([0, 1, 2, 3].map((i) => key(periodBoundary(anchor, "MONTH", 1, i, NBO)))).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(toWallTime(periodBoundary(anchor, "MONTH", 1, 1, NBO), NBO).hour).toBe(10);
  });

  it("handles leap years for monthly and yearly anchors", () => {
    expect(key(periodBoundary(nairobi(2028, 1, 31), "MONTH", 1, 1, NBO))).toBe("2028-02-29");
    const leap = nairobi(2028, 2, 29);
    expect([1, 2, 3, 4].map((i) => key(periodBoundary(leap, "YEAR", 1, i, NBO)))).toEqual(["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
  });

  it("supports multi-unit intervals and day/week/hour units", () => {
    const anchor = nairobi(2026, 11, 30);
    expect(key(periodBoundary(anchor, "MONTH", 3, 1, NBO))).toBe("2027-02-28");
    expect(key(periodBoundary(anchor, "MONTH", 3, 2, NBO))).toBe("2027-05-30");
    expect(key(periodBoundary(anchor, "WEEK", 1, 1, NBO))).toBe("2026-12-07");
    expect(key(periodBoundary(anchor, "DAY", 30, 1, NBO))).toBe("2026-12-30");
    expect(periodBoundary(anchor, "HOUR", 24, 1, NBO).getTime() - anchor.getTime()).toBe(86_400_000);
    expect(key(periodBoundary(nairobi(2026, 12, 31, 23, 30), "DAY", 1, 1, NBO))).toBe("2027-01-01");
  });

  it("returns contiguous periods", () => {
    const anchor = nairobi(2026, 1, 15);
    const p0 = periodAt(anchor, "MONTH", 1, 0, NBO);
    const p1 = periodAt(anchor, "MONTH", 1, 1, NBO);
    expect(p0.end.getTime()).toBe(p1.start.getTime());
  });

  it("rejects invalid inputs", () => {
    expect(() => periodBoundary(new Date(), "MONTH", 0, 1, NBO)).toThrow();
    expect(() => periodBoundary(new Date(), "MONTH", 1, -1, NBO)).toThrow();
  });
});

describe("subscription state machine", () => {
  it("allows only defined transitions", () => {
    expect(nextStatus("PENDING", "activate")).toBe("ACTIVE");
    expect(nextStatus("ACTIVE", "activate")).toBeNull();
    expect(nextStatus("ACTIVE", "suspend")).toBe("SUSPENDED");
    expect(nextStatus("SUSPENDED", "reactivate")).toBe("ACTIVE");
    expect(nextStatus("EXPIRED", "renew")).toBe("ACTIVE");
    expect(nextStatus("CANCELLED", "renew")).toBeNull();
    expect(nextStatus("CANCELLED", "reactivate")).toBeNull();
    expect(allowedActions("CANCELLED")).toEqual([]);
    expect(allowedActions("ACTIVE").sort()).toEqual(["cancel", "renew", "suspend"]);
  });

  it("continues renewals only when the current period is still running", () => {
    const now = new Date("2026-10-25T10:00:00Z");
    expect(renewalContinues("ACTIVE", new Date("2026-10-30T00:00:00Z"), now)).toBe(true);
    expect(renewalContinues("ACTIVE", new Date("2026-10-20T00:00:00Z"), now)).toBe(false);
    expect(renewalContinues("EXPIRED", new Date("2026-10-30T00:00:00Z"), now)).toBe(false);
  });
});

describe("phone normalisation", () => {
  it.each([
    ["0712345678", "254712345678"],
    ["0712 345 678", "254712345678"],
    ["712345678", "254712345678"],
    ["+254712345678", "254712345678"],
    ["254110123456", "254110123456"],
    ["0110123456", "254110123456"],
    ["+44 20 7946 0958", "442079460958"],
  ])("%s → %s", (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it.each(["", "12345", "0812345678", "2547123456", "abc", "+254 812 345 678"])("rejects %s", (input) => expect(normalizePhone(input)).toBeNull());

  it("formats for display", () => expect(formatPhone("254712345678")).toBe("+254 712 345 678"));
});

describe("money", () => {
  it("validates and keeps decimal precision", () => {
    expect(moneyInput.parse("1500")).toBe("1500");
    expect(moneyInput.safeParse("10.999").success).toBe(false);
    expect(moneyInput.safeParse("-5").success).toBe(false);
    expect(positiveMoneyInput.safeParse("0").success).toBe(false);
    expect(sumMoney(["0.1", "0.2"]).toFixed(2)).toBe("0.30");
    expect(moneyString(new D("2.345"))).toBe("2.35");
    expect(moneyString(new D("2.344"))).toBe("2.34");
  });
});

describe("CSV", () => {
  it("parses quoted fields, escaped quotes, CRLF and BOM", () => {
    const { headers, rows } = parseCsv('﻿Name,Phone,Notes\r\n"Doe, Jane",0712345678,"said ""hi"""\r\nJohn,0722000000,\r\n');
    expect(headers).toEqual(["name", "phone", "notes"]);
    expect(rows).toEqual([
      { name: "Doe, Jane", phone: "0712345678", notes: 'said "hi"' },
      { name: "John", phone: "0722000000", notes: "" },
    ]);
  });

  it("rejects malformed and oversized files", () => {
    expect(() => parseCsv('a,b\n"unterminated,1')).toThrow(CsvError);
    expect(() => parseCsv("")).toThrow(CsvError);
    expect(() => parseCsv("a,a\n1,2")).toThrow(/duplicate/);
    expect(() => parseCsv("a\n1\n2\n3", { maxRows: 2 })).toThrow(/more than 2/);
  });

  it("neutralises formula injection on export", () => {
    expect(csvCell("=HYPERLINK()")).toBe("'=HYPERLINK()");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(null)).toBe("");
  });
});
