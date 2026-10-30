import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/server/db/client";
import type { ActorContext } from "@/server/auth/context";

/** Raw-SQL equivalent of listWhere's branch condition on `column` (empty when the caller sees every branch). */
export function branchFilterSql(ctx: ActorContext, column: Prisma.Sql) {
  if (ctx.kind !== "staff") return Prisma.empty;
  if (ctx.activeBranchId) return Prisma.sql`AND ${column} = ${ctx.activeBranchId}::uuid`;
  if (ctx.branchIds) return ctx.branchIds.length ? Prisma.sql`AND ${column} IN (${Prisma.join(ctx.branchIds.map((b) => Prisma.sql`${b}::uuid`))})` : Prisma.sql`AND false`;
  return Prisma.empty;
}

/** Atomically increment and return a per-organization counter (row-level lock via upsert). */
export async function nextCounter(tx: Tx, organizationId: string, key: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "OrganizationCounter" ("organizationId", "key", "value") VALUES (${organizationId}::uuid, ${key}, 1)
    ON CONFLICT ("organizationId", "key") DO UPDATE SET "value" = "OrganizationCounter"."value" + 1
    RETURNING "value"`;
  return Number(rows[0]!.value);
}

export function formatAccountNumber(n: number): string {
  return `A${String(n).padStart(6, "0")}`;
}

/** Lock a row for the rest of the transaction (SELECT … FOR UPDATE). Table name must be a trusted literal. */
export async function lockRow(tx: Tx, table: "Subscription" | "Lead" | "Subscriber" | "ImportJob" | "Package", id: string): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "${table}" WHERE "id" = $1::uuid FOR UPDATE`, id);
  return rows.length === 1;
}

export function actorUserId(ctx: ActorContext): string | null {
  return ctx.kind === "staff" ? ctx.userId : null;
}

export function actorType(ctx: ActorContext): string {
  if (ctx.kind === "staff") return "user";
  if (ctx.kind === "customer") return "customer";
  return ctx.actor;
}

/** Search term sanitiser: trims, caps length; Prisma parameterises the value. */
export function searchTerm(q: string | undefined): string | undefined {
  const v = q?.trim().slice(0, 100);
  return v ? v : undefined;
}
