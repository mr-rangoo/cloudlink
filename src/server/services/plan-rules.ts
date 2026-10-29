import "server-only";
import { db, type Tx } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { toWallTime } from "@/server/domain/time";
import { describeSchedule, scheduleOpen } from "@/lib/plans";
import type { Package } from "@/generated/prisma/client";

/** Rules applied when a plan is sold, redeemed or provisioned (kept apart from the plan service to avoid import cycles). */

/** Plans restricted to certain routers may only be provisioned or sold on those routers. */
export async function assertPlanAllowedOnRouter(client: Tx | typeof db, packageId: string, routerId: string | null) {
  const restricted = await client.packageRouter.findMany({ where: { packageId }, select: { routerId: true } });
  if (!restricted.length) return;
  if (!routerId || !restricted.some((r) => r.routerId === routerId)) {
    throw new AppError("INVALID_STATE", "This plan is limited to other routers.", { fields: [{ path: "routerId", message: "Not allowed for this plan" }] });
  }
}

type Schedule = Pick<Package, "scheduleEnabled" | "scheduleStartMinute" | "scheduleEndMinute" | "scheduleDays">;

/** Scheduled plans (e.g. a night plan) can only be started inside their time window, in the organization timezone. */
export function planOpenAt(pkg: Schedule, now: Date, tz: string): boolean {
  if (!pkg.scheduleEnabled) return true;
  const w = toWallTime(now, tz);
  const weekday = (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7; // Monday = 0
  return scheduleOpen(pkg, { weekday, minute: w.hour * 60 + w.minute });
}

export function assertPlanOpen(pkg: Schedule & { name: string }, now: Date, tz: string) {
  if (!planOpenAt(pkg, now, tz)) throw new AppError("INVALID_STATE", `${pkg.name} is only available ${describeSchedule(pkg) ?? "at scheduled times"}.`);
}
