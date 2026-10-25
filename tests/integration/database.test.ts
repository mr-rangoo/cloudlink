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
});
