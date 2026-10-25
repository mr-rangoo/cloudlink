import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";

describe("database conventions", () => {
  it("runs sessions in UTC so Prisma-written instants agree with SQL now()", async () => {
    const [row] = await db.$queryRaw<Array<{ tz: string; now: Date }>>`SELECT current_setting('TimeZone') AS tz, now() AS now`;
    expect(row!.tz).toBe("UTC");
    expect(Math.abs(row!.now.getTime() - Date.now())).toBeLessThan(5_000);

    const written = new Date();
    const op = await db.backgroundOperation.create({ data: { type: "tz.check", payload: {}, runAfter: written } });
    const [cmp] = await db.$queryRaw<Array<{ diff: number }>>`
      SELECT EXTRACT(EPOCH FROM ("runAfter" - now()))::float AS diff FROM "BackgroundOperation" WHERE id = ${op.id}::uuid`;
    expect(Math.abs(cmp!.diff)).toBeLessThan(5);
  });

  it("rejects invalid catalogue values at the database level", async () => {
    const org = await db.organization.create({ data: { name: "Check Org", slug: `check-${Date.now()}` } });
    const base = { organizationId: org.id, name: "Bad", serviceType: "PPPOE" as const, currency: "KES" };
    await expect(db.package.create({ data: { ...base, price: "-1" } })).rejects.toThrow();
    await expect(db.package.create({ data: { ...base, price: "1", taxRate: "101" } })).rejects.toThrow();
    await expect(db.package.create({ data: { ...base, price: "1", billingCount: 0 } })).rejects.toThrow();
    await expect(db.package.create({ data: { ...base, price: "1", currency: "kes" } })).rejects.toThrow();
    await expect(db.package.create({ data: { ...base, price: "1" } })).resolves.toBeTruthy();
  });
});
