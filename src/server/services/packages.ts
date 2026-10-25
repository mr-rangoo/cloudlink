import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { moneyInput, percentInput } from "@/server/domain/money";
import { searchTerm } from "@/server/services/common";
import type { Prisma } from "@/generated/prisma/client";

const optionalPositiveInt = z.union([z.coerce.number().int().positive().max(100_000_000), z.literal("").transform(() => null), z.null()]).optional();

export const packageInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  serviceType: z.enum(["PPPOE", "HOTSPOT", "STATIC_IP", "OTHER"]),
  price: moneyInput,
  taxRate: percentInput.default("0"),
  billingUnit: z.enum(["HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).default("MONTH"),
  billingCount: z.coerce.number().int().min(1).max(365).default(1),
  downloadKbps: optionalPositiveInt,
  uploadKbps: optionalPositiveInt,
  dataQuotaMb: optionalPositiveInt,
  deviceLimit: optionalPositiveInt,
});

export const packageUpdate = packageInput.partial().extend({ status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional() });

export const packageListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED", "ALL"]).default("ALL"),
  serviceType: z.enum(["PPPOE", "HOTSPOT", "STATIC_IP", "OTHER"]).optional(),
});

export const packageSelect = {
  id: true,
  name: true,
  description: true,
  serviceType: true,
  price: true,
  currency: true,
  taxRate: true,
  billingUnit: true,
  billingCount: true,
  downloadKbps: true,
  uploadKbps: true,
  dataQuotaMb: true,
  deviceLimit: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PackageSelect;

export async function listPackages(ctx: ActorContext, query: z.infer<typeof packageListQuery>) {
  requirePermission(ctx, "packages.read");
  const q = searchTerm(query.q);
  const where: Prisma.PackageWhereInput = {
    organizationId: ctx.organizationId,
    ...(query.status !== "ALL" ? { status: query.status } : { status: { not: "ARCHIVED" } }),
    ...(query.serviceType ? { serviceType: query.serviceType } : {}),
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
  };
  const rows = await db.package.findMany({
    where,
    select: { ...packageSelect, _count: { select: { subscriptions: { where: { status: { in: ["ACTIVE", "SUSPENDED"] } } } } } },
    orderBy: [{ status: "asc" }, { price: "asc" }],
  });
  return rows.map(({ _count, ...p }) => ({ ...p, activeSubscriptions: _count.subscriptions }));
}

export async function getPackage(ctx: ActorContext, id: string) {
  requirePermission(ctx, "packages.read");
  const pkg = await db.package.findFirst({ where: { id, organizationId: ctx.organizationId }, select: packageSelect });
  if (!pkg) throw notFound("package");
  return pkg;
}

export async function createPackage(ctx: ActorContext, input: z.infer<typeof packageInput>) {
  requirePermission(ctx, "packages.write");
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
  const pkg = await db.package.create({
    data: { ...input, organizationId: ctx.organizationId, currency: org.currency, description: input.description ?? null },
    select: packageSelect,
  });
  await audit(ctx, { action: "package.create", entityType: "package", entityId: pkg.id, metadata: { name: pkg.name, price: pkg.price.toString(), currency: pkg.currency } });
  return pkg;
}

/**
 * Update a package. Price/terms changes apply to new subscriptions only: existing subscriptions keep their
 * commercial snapshot, so issued and future invoices for them are unaffected.
 */
export async function updatePackage(ctx: ActorContext, id: string, input: z.infer<typeof packageUpdate>) {
  requirePermission(ctx, "packages.write");
  const before = await db.package.findFirst({ where: { id, organizationId: ctx.organizationId }, select: packageSelect });
  if (!before) throw notFound("package");
  if (input.status === "ARCHIVED") {
    const live = await db.subscription.count({ where: { packageId: id, status: { in: ["ACTIVE", "SUSPENDED", "PENDING"] } } });
    if (live > 0) throw new AppError("INVALID_STATE", `This package has ${live} live subscription(s). Move them to another package before archiving.`);
  }
  const pkg = await db.package.update({ where: { id }, data: input, select: packageSelect });
  const changed = Object.keys(input).filter((k) => String((before as Record<string, unknown>)[k]) !== String((pkg as Record<string, unknown>)[k]));
  await audit(ctx, {
    action: "package.update",
    entityType: "package",
    entityId: id,
    metadata: { changed, before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (pkg as Record<string, unknown>)[k]])) },
  });
  return pkg;
}
