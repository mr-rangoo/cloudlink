import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, resolveBranchForCreate, tenantWhere, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { moneyInput } from "@/server/domain/money";
import { searchTerm } from "@/server/services/common";
import type { InventoryStatus, Prisma } from "@/generated/prisma/client";

/**
 * Equipment inventory with an append-only movement history.
 * Status rules: IN_STOCK → ASSIGNED (needs a subscriber) → returned to IN_STOCK; any non-retired item can be marked
 * FAULTY; FAULTY → IN_STOCK (repaired); RETIRED is terminal. An assigned item always has a subscriber (DB CHECK).
 */
const CATEGORIES = ["router", "onu", "cpe", "antenna", "switch", "other"] as const;

export const itemInput = z.object({
  category: z.enum(CATEGORIES),
  model: z.string().trim().min(2).max(120),
  serialNumber: z.string().trim().toUpperCase().min(3).max(80),
  macAddress: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/, "Use the format AA:BB:CC:DD:EE:FF")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  purchaseCost: moneyInput.optional().nullable(),
  purchasedAt: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  branchId: z.uuid().optional().nullable(),
});

export const itemActionInput = z.object({
  action: z.enum(["assign", "return", "mark_faulty", "repaired", "retire"]),
  subscriberId: z.uuid().optional(),
  note: z.string().trim().max(500).optional(),
});

export const inventoryQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["IN_STOCK", "ASSIGNED", "FAULTY", "RETIRED", "ALL"]).default("ALL"),
  category: z.enum(CATEGORIES).optional(),
  subscriberId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const TRANSITIONS: Record<z.infer<typeof itemActionInput>["action"], { from: InventoryStatus[]; to: InventoryStatus }> = {
  assign: { from: ["IN_STOCK"], to: "ASSIGNED" },
  return: { from: ["ASSIGNED"], to: "IN_STOCK" },
  mark_faulty: { from: ["IN_STOCK", "ASSIGNED"], to: "FAULTY" },
  repaired: { from: ["FAULTY"], to: "IN_STOCK" },
  retire: { from: ["IN_STOCK", "FAULTY"], to: "RETIRED" },
};

export async function listInventory(ctx: StaffContext, q: z.infer<typeof inventoryQuery>) {
  requirePermission(ctx, "inventory.read");
  const s = searchTerm(q.q);
  const where: Prisma.InventoryItemWhereInput = {
    organizationId: ctx.organizationId,
    ...(ctx.branchIds ? { OR: [{ branchId: { in: ctx.branchIds } }, { branchId: null }] } : {}),
    ...(q.status !== "ALL" ? { status: q.status } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.subscriberId ? { subscriberId: q.subscriberId } : {}),
    ...(s ? { AND: [{ OR: [{ serialNumber: { contains: s.toUpperCase() } }, { model: { contains: s, mode: "insensitive" } }, { macAddress: { contains: s.toUpperCase() } }] }] } : {}),
  };
  const [rows, total, counts] = await Promise.all([
    db.inventoryItem.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    db.inventoryItem.count({ where }),
    db.inventoryItem.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId }, _count: { _all: true } }),
  ]);
  const subs = new Map((await db.subscriber.findMany({ where: { id: { in: rows.map((r) => r.subscriberId).filter((v): v is string => Boolean(v)) } }, select: { id: true, displayName: true, accountNumber: true } })).map((x) => [x.id, x]));
  return { rows: rows.map((r) => ({ ...r, subscriber: r.subscriberId ? (subs.get(r.subscriberId) ?? null) : null })), total, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
}

export async function createItem(ctx: StaffContext, input: z.infer<typeof itemInput>) {
  requirePermission(ctx, "inventory.write");
  const branchId = input.branchId ? await resolveBranchForCreate(ctx, input.branchId) : ctx.branchIds ? await resolveBranchForCreate(ctx, null) : null;
  const item = await db.$transaction(async (tx) => {
    const i = await tx.inventoryItem.create({
      data: { organizationId: ctx.organizationId, branchId, category: input.category, model: input.model, serialNumber: input.serialNumber, macAddress: input.macAddress ?? null, purchaseCost: input.purchaseCost ?? null, purchasedAt: input.purchasedAt ?? null, notes: input.notes ?? null },
    });
    await tx.inventoryMovement.create({ data: { organizationId: ctx.organizationId, itemId: i.id, action: "received", toStatus: "IN_STOCK", actorUserId: ctx.userId } });
    return i;
  });
  await audit(ctx, { action: "inventory.create", entityType: "inventory_item", entityId: item.id, metadata: { serial: item.serialNumber } });
  return item;
}

export async function applyItemAction(ctx: StaffContext, id: string, input: z.infer<typeof itemActionInput>) {
  requirePermission(ctx, "inventory.write");
  const t = TRANSITIONS[input.action];
  const result = await db.$transaction(async (tx) => {
    if (!(await tx.inventoryItem.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } }))) throw notFound("item");
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound("item");
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id } });
    if (!t.from.includes(item.status)) throw new AppError("INVALID_STATE", `A ${item.status.toLowerCase().replace("_", " ")} item cannot be ${input.action.replace("_", " ")}.`);
    let subscriberId: string | null = null;
    if (input.action === "assign") {
      if (!input.subscriberId) throw new AppError("VALIDATION_ERROR", "Choose the subscriber receiving this item.", { fields: [{ path: "subscriberId", message: "Required" }] });
      const sub = await tx.subscriber.findFirst({ where: { id: input.subscriberId, ...tenantWhere(ctx) }, select: { id: true } });
      if (!sub) throw notFound("subscriber");
      subscriberId = sub.id;
    }
    const updated = await tx.inventoryItem.update({ where: { id }, data: { status: t.to, subscriberId: t.to === "ASSIGNED" ? subscriberId : null } });
    await tx.inventoryMovement.create({
      data: { organizationId: ctx.organizationId, itemId: id, action: input.action === "assign" ? "assigned" : input.action === "return" ? "returned" : input.action === "mark_faulty" ? "marked_faulty" : input.action === "repaired" ? "repaired" : "retired", fromStatus: item.status, toStatus: t.to, subscriberId: subscriberId ?? item.subscriberId, actorUserId: ctx.userId, note: input.note ?? null },
    });
    const affected = subscriberId ?? item.subscriberId;
    if (affected && (input.action === "assign" || input.action === "return" || item.status === "ASSIGNED")) {
      await tx.subscriberActivity.create({ data: { organizationId: ctx.organizationId, subscriberId: affected, actorUserId: ctx.userId, type: `equipment.${input.action}`, message: `${item.model} (${item.serialNumber}) ${input.action === "assign" ? "assigned" : input.action === "return" ? "returned" : input.action.replace("_", " ")}` } });
    }
    return updated;
  });
  await audit(ctx, { action: `inventory.${input.action}`, entityType: "inventory_item", entityId: id, metadata: { subscriberId: input.subscriberId, note: input.note } });
  return result;
}

export async function getItem(ctx: StaffContext, id: string) {
  requirePermission(ctx, "inventory.read");
  const item = await db.inventoryItem.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { movements: { orderBy: { createdAt: "desc" }, take: 100 } } });
  if (!item) throw notFound("item");
  return item;
}
