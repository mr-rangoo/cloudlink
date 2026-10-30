import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { listWhere, requirePermission, resolveBranchForCreate, tenantWhere, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { normalizeEmail, normalizePhone } from "@/server/domain/contact";
import { actorUserId, formatAccountNumber, nextCounter, searchTerm } from "@/server/services/common";
import { createSubscriptionTx, subscriptionSelect } from "@/server/services/subscriptions";
import type { Prisma } from "@/generated/prisma/client";

const phoneField = z
  .string()
  .trim()
  .min(1, "Phone number is required.")
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: "custom", message: "Enter a valid phone number, e.g. 0712 345 678." });
    return n ?? "";
  });

const optionalPhone = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v) return null;
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: "custom", message: "Enter a valid phone number." });
    return n;
  });

const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v) return null;
    if (!z.email().safeParse(v).success) ctx.addIssue({ code: "custom", message: "Enter a valid email address." });
    return v;
  });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    // Absent stays absent (PATCH must not clear fields it did not send); empty string clears.
    .transform((v) => (v === undefined ? undefined : v ? v : null));

export const addressInput = z.object({
  line1: z.string().trim().min(2).max(200),
  area: optionalText(100),
  town: optionalText(100),
  county: optionalText(100),
});

export const subscriberInput = z
  .object({
    type: z.enum(["INDIVIDUAL", "BUSINESS"]).default("INDIVIDUAL"),
    firstName: optionalText(80),
    lastName: optionalText(80),
    companyName: optionalText(160),
    email: optionalEmail,
    phone: phoneField,
    altPhone: optionalPhone,
    idNumber: optionalText(40),
    notes: optionalText(2000),
    branchId: z.uuid().optional().nullable(),
    address: addressInput.optional().nullable(),
    packageId: z.uuid().optional().nullable(),
    activateSubscription: z.boolean().default(true),
    allowDuplicateContact: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.type === "BUSINESS" && !v.companyName) ctx.addIssue({ code: "custom", path: ["companyName"], message: "Company name is required for business accounts." });
    if (v.type === "INDIVIDUAL" && !v.firstName) ctx.addIssue({ code: "custom", path: ["firstName"], message: "First name is required." });
  });

export const subscriberUpdate = z.object({
  firstName: optionalText(80),
  lastName: optionalText(80),
  companyName: optionalText(160),
  email: optionalEmail,
  phone: phoneField.optional(),
  altPhone: optionalPhone,
  idNumber: optionalText(40),
  notes: optionalText(2000),
  branchId: z.uuid().optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional(),
  vip: z.boolean().optional(),
});

export const subscriberListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED", "ALL"]).default("ALL"),
  subscription: z.enum(["ACTIVE", "SUSPENDED", "EXPIRED", "NONE"]).optional(),
  /** Has a live subscription of this access type. */
  service: z.enum(["PPPOE", "HOTSPOT", "STATIC_IP", "OTHER"]).optional(),
  /** online: a session is open now; offline: an active subscription with network access but no open session. */
  connection: z.enum(["online", "offline"]).optional(),
  routerId: z.uuid().optional(),
  created: z.enum(["7d", "30d", "90d"]).optional(),
  vip: z.enum(["1"]).optional(),
  /** At risk: active and the paid period ends within 3 days, or expired within the last 7 days. */
  risk: z.enum(["1"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(["newest", "oldest", "name", "account"]).default("newest"),
});

export const noteInput = z.object({ message: z.string().trim().min(1).max(2000) });

export function displayNameOf(v: { type: string; firstName?: string | null; lastName?: string | null; companyName?: string | null }): string {
  if (v.type === "BUSINESS" && v.companyName) return v.companyName;
  return [v.firstName, v.lastName].filter(Boolean).join(" ").trim() || v.companyName || "Unnamed";
}

/** Existing subscribers in the organization sharing the phone or email (for duplicate warnings). */
export async function findContactDuplicates(client: Tx | typeof db, organizationId: string, phone: string | null | undefined, email: string | null | undefined, excludeId?: string) {
  const or: Prisma.SubscriberWhereInput[] = [];
  if (phone) or.push({ phone });
  if (email) or.push({ emailNormalized: normalizeEmail(email) });
  if (!or.length) return [];
  return client.subscriber.findMany({
    where: { organizationId, OR: or, status: { not: "ARCHIVED" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, accountNumber: true, displayName: true },
    take: 5,
  });
}

export const subscriberListSelect = {
  id: true,
  accountNumber: true,
  type: true,
  displayName: true,
  email: true,
  phone: true,
  status: true,
  vip: true,
  branchId: true,
  createdAt: true,
} satisfies Prisma.SubscriberSelect;

/** Shared create used by the API, lead conversion and CSV import. */
export async function createSubscriberTx(tx: Tx, ctx: ActorContext, input: z.infer<typeof subscriberInput>, opts: { source?: string } = {}) {
  const branchId = await resolveBranchForCreate(ctx, input.branchId);
  if (!input.allowDuplicateContact) {
    const dupes = await findContactDuplicates(tx, ctx.organizationId, input.phone, input.email);
    if (dupes.length) {
      throw new AppError("CONFLICT", `A subscriber with this phone or email already exists (${dupes.map((d) => `${d.accountNumber} ${d.displayName}`).join(", ")}).`, {
        details: { duplicates: dupes },
      });
    }
  }
  const accountNumber = formatAccountNumber(await nextCounter(tx, ctx.organizationId, "subscriber.account"));
  const subscriber = await tx.subscriber.create({
    data: {
      organizationId: ctx.organizationId,
      branchId,
      accountNumber,
      type: input.type,
      displayName: displayNameOf(input),
      firstName: input.firstName,
      lastName: input.lastName,
      companyName: input.companyName,
      email: input.email,
      emailNormalized: normalizeEmail(input.email),
      phone: input.phone,
      altPhone: input.altPhone,
      idNumber: input.idNumber,
      notes: input.notes,
      createdById: actorUserId(ctx),
      ...(input.address ? { addresses: { create: { organizationId: ctx.organizationId, ...input.address } } } : {}),
    },
    select: subscriberListSelect,
  });
  await tx.subscriberActivity.create({
    data: { organizationId: ctx.organizationId, subscriberId: subscriber.id, actorUserId: actorUserId(ctx), type: "created", message: `Subscriber account ${accountNumber} created${opts.source ? ` (${opts.source})` : ""}` },
  });
  let subscription = null;
  if (input.packageId) {
    requirePermission(ctx, "subscriptions.write");
    subscription = await createSubscriptionTx(tx, ctx, { subscriberId: subscriber.id, packageId: input.packageId, activate: input.activateSubscription, graceDays: 0, autoRenew: true });
  }
  return { subscriber, subscription };
}

export async function createSubscriber(ctx: ActorContext, input: z.infer<typeof subscriberInput>) {
  requirePermission(ctx, "subscribers.write");
  const result = await db.$transaction((tx) => createSubscriberTx(tx, ctx, input));
  await audit(ctx, {
    action: "subscriber.create",
    entityType: "subscriber",
    entityId: result.subscriber.id,
    metadata: { accountNumber: result.subscriber.accountNumber, subscriptionId: result.subscription?.id, duplicateOverride: input.allowDuplicateContact || undefined },
  });
  return result;
}

const LIVE = ["ACTIVE", "SUSPENDED", "PENDING"] as Array<"ACTIVE" | "SUSPENDED" | "PENDING">;

/** Subscribers with a session open right now (any router; sessions are matched to subscribers at sync). */
async function onlineSubscriberIds(organizationId: string): Promise<string[]> {
  const rows = await db.networkSession.findMany({ where: { organizationId, endedAt: null, subscriberId: { not: null } }, select: { subscriberId: true }, distinct: ["subscriberId"] });
  return rows.map((r) => r.subscriberId!);
}

/** Active with network access but not connected now. */
const offlineWhere = (online: string[]): Prisma.SubscriberWhereInput => ({ id: { notIn: online }, subscriptions: { some: { status: "ACTIVE", networkUsername: { not: null } } } });

const riskWhere = (now: Date): Prisma.SubscriberWhereInput => ({
  subscriptions: {
    some: {
      OR: [
        { status: "ACTIVE", currentPeriodEnd: { lte: new Date(now.getTime() + 3 * 86_400_000) } },
        { status: "EXPIRED", currentPeriodEnd: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
      ],
    },
  },
});

export async function listSubscribers(ctx: ActorContext, query: z.infer<typeof subscriberListQuery>) {
  requirePermission(ctx, "subscribers.read");
  const q = searchTerm(query.q);
  const phoneQ = q ? normalizePhone(q) : null;
  const now = new Date();
  const online = query.connection ? await onlineSubscriberIds(ctx.organizationId) : [];
  const and: Prisma.SubscriberWhereInput[] = [];
  if (query.subscription === "NONE") and.push({ subscriptions: { none: { status: { in: LIVE } } } });
  else if (query.subscription) and.push({ subscriptions: { some: { status: query.subscription } } });
  if (query.service) and.push({ subscriptions: { some: { status: { in: LIVE }, serviceType: query.service } } });
  if (query.routerId) and.push({ subscriptions: { some: { networkRouterId: query.routerId } } });
  if (query.connection === "online") and.push({ id: { in: online } });
  if (query.connection === "offline") and.push(offlineWhere(online));
  if (query.risk) and.push(riskWhere(now));
  const where: Prisma.SubscriberWhereInput = {
    ...listWhere(ctx),
    ...(query.status !== "ALL" ? { status: query.status } : { status: { not: "ARCHIVED" } }),
    ...(query.vip ? { vip: true } : {}),
    ...(query.created ? { createdAt: { gte: new Date(now.getTime() - Number(query.created.replace("d", "")) * 86_400_000) } } : {}),
    ...(and.length ? { AND: and } : {}),
    ...(q
      ? {
          OR: [
            { displayName: { contains: q, mode: "insensitive" } },
            { accountNumber: { contains: q, mode: "insensitive" } },
            { emailNormalized: { contains: q.toLowerCase() } },
            { phone: { contains: phoneQ ?? (q.replace(/\D/g, "") || q) } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.SubscriberOrderByWithRelationInput =
    query.sort === "oldest" ? { createdAt: "asc" } : query.sort === "name" ? { displayName: "asc" } : query.sort === "account" ? { accountNumber: "asc" } : { createdAt: "desc" };
  const [rows, total] = await Promise.all([
    db.subscriber.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        ...subscriberListSelect,
        subscriptions: {
          where: { status: { in: ["ACTIVE", "SUSPENDED", "PENDING", "EXPIRED"] } },
          select: { id: true, status: true, packageName: true, serviceType: true, currentPeriodEnd: true, networkRouterId: true },
          orderBy: { createdAt: "desc" },
          take: 3,
        },
      },
    }),
    db.subscriber.count({ where }),
  ]);
  // Connection details for the page: open sessions and the last time each subscriber was seen online.
  const ids = rows.map((r) => r.id);
  const routerIds = [...new Set(rows.flatMap((r) => r.subscriptions.map((s) => s.networkRouterId).filter((x): x is string => Boolean(x))))];
  const [seen, openNow, routers] = await Promise.all([
    ids.length ? db.networkSession.groupBy({ by: ["subscriberId"], where: { organizationId: ctx.organizationId, subscriberId: { in: ids } }, _max: { lastSeenAt: true } }) : [],
    ids.length ? db.networkSession.findMany({ where: { organizationId: ctx.organizationId, subscriberId: { in: ids }, endedAt: null }, select: { subscriberId: true }, distinct: ["subscriberId"] }) : [],
    routerIds.length ? db.router.findMany({ where: { organizationId: ctx.organizationId, id: { in: routerIds } }, select: { id: true, name: true } }) : [],
  ]);
  return {
    rows: rows.map((r) => {
      const routerId = r.subscriptions.find((s) => s.networkRouterId)?.networkRouterId ?? null;
      return {
        ...r,
        online: openNow.some((o) => o.subscriberId === r.id),
        lastSeenAt: seen.find((x) => x.subscriberId === r.id)?._max.lastSeenAt ?? null,
        router: routerId ? (routers.find((x) => x.id === routerId) ?? null) : null,
      };
    }),
    total,
  };
}

/**
 * Subscriber list headline figures (same scope as the list): accounts (not archived), with an active subscription,
 * online now, active-but-offline, at risk (see riskWhere), VIP, and new in the last 30 days.
 */
export async function subscriberStats(ctx: ActorContext) {
  requirePermission(ctx, "subscribers.read");
  const now = new Date();
  const base: Prisma.SubscriberWhereInput = { ...listWhere(ctx), status: { not: "ARCHIVED" } };
  const online = await onlineSubscriberIds(ctx.organizationId);
  const [total, active, onlineCount, offline, atRisk, vip, recent] = await Promise.all([
    db.subscriber.count({ where: base }),
    db.subscriber.count({ where: { ...base, subscriptions: { some: { status: "ACTIVE" } } } }),
    db.subscriber.count({ where: { ...base, id: { in: online } } }),
    db.subscriber.count({ where: { ...base, ...offlineWhere(online) } }),
    db.subscriber.count({ where: { ...base, ...riskWhere(now) } }),
    db.subscriber.count({ where: { ...base, vip: true } }),
    db.subscriber.count({ where: { ...base, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } }),
  ]);
  return { total, active, online: onlineCount, offline, atRisk, vip, newLast30Days: recent };
}

export async function getSubscriber(ctx: ActorContext, id: string) {
  requirePermission(ctx, "subscribers.read");
  const subscriber = await db.subscriber.findFirst({
    where: { id, ...tenantWhere(ctx) },
    select: {
      ...subscriberListSelect,
      firstName: true,
      lastName: true,
      companyName: true,
      altPhone: true,
      idNumber: true,
      notes: true,
      updatedAt: true,
      addresses: { select: { id: true, label: true, line1: true, area: true, town: true, county: true } },
      contacts: { select: { id: true, name: true, phone: true, email: true, relationship: true, isPrimary: true } },
      subscriptions: { select: subscriptionSelect, orderBy: { createdAt: "desc" } },
      lead: { select: { id: true, name: true, source: true, createdAt: true } },
    },
  });
  if (!subscriber) throw notFound("subscriber");
  const branch = subscriber.branchId ? await db.branch.findUnique({ where: { id: subscriber.branchId }, select: { id: true, name: true, code: true } }) : null;
  return { ...subscriber, branch };
}

export async function updateSubscriber(ctx: ActorContext, id: string, input: z.infer<typeof subscriberUpdate>) {
  requirePermission(ctx, "subscribers.write");
  const before = await db.subscriber.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!before) throw notFound("subscriber");
  if (input.branchId !== undefined && input.branchId !== before.branchId) await resolveBranchForCreate(ctx, input.branchId);
  if (input.status === "ARCHIVED") {
    const live = await db.subscription.count({ where: { subscriberId: id, status: { in: ["ACTIVE", "SUSPENDED", "PENDING"] } } });
    if (live) throw new AppError("INVALID_STATE", "Cancel or expire live subscriptions before archiving this subscriber.");
  }

  const merged = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  const data: Prisma.SubscriberUpdateInput = {
    ...input,
    branchId: undefined,
    ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    displayName: displayNameOf(merged as { type: string }),
    ...(input.email !== undefined ? { emailNormalized: normalizeEmail(input.email) } : {}),
  };
  const updated = await db.$transaction(async (tx) => {
    const s = await tx.subscriber.update({ where: { id }, data, select: subscriberListSelect });
    const changed = Object.keys(input).filter((k) => String((before as Record<string, unknown>)[k] ?? "") !== String((input as Record<string, unknown>)[k] ?? ""));
    if (changed.length) {
      await tx.subscriberActivity.create({
        data: { organizationId: ctx.organizationId, subscriberId: id, actorUserId: actorUserId(ctx), type: "updated", message: `Updated ${changed.join(", ")}`, metadata: { changed } },
      });
    }
    return { s, changed };
  });
  await audit(ctx, { action: "subscriber.update", entityType: "subscriber", entityId: id, metadata: { changed: updated.changed } });
  return updated.s;
}

export async function addSubscriberNote(ctx: ActorContext, id: string, message: string) {
  requirePermission(ctx, "subscribers.write");
  const s = await db.subscriber.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true } });
  if (!s) throw notFound("subscriber");
  return db.subscriberActivity.create({
    data: { organizationId: ctx.organizationId, subscriberId: id, actorUserId: actorUserId(ctx), type: "note", message },
    select: { id: true, type: true, message: true, createdAt: true },
  });
}

export async function listSubscriberActivity(ctx: ActorContext, id: string, take = 50) {
  requirePermission(ctx, "subscribers.read");
  const s = await db.subscriber.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true } });
  if (!s) throw notFound("subscriber");
  const rows = await db.subscriberActivity.findMany({
    where: { subscriberId: id },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, type: true, message: true, actorUserId: true, createdAt: true },
  });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v)))];
  const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(actors.map((a) => [a.id, a.name]));
  return rows.map((r) => ({ ...r, actorName: r.actorUserId ? (names.get(r.actorUserId) ?? "Staff") : "System" }));
}

/** Resolve the subscription a subscriber-level action applies to (explicit id, or the only live one). */
export async function resolveSubscriberSubscription(ctx: ActorContext, subscriberId: string, subscriptionId?: string) {
  const subs = await db.subscription.findMany({
    where: { subscriberId, ...tenantWhere(ctx), ...(subscriptionId ? { id: subscriptionId } : { status: { not: "CANCELLED" } }) },
    select: { id: true },
  });
  if (subs.length === 0) throw notFound("subscription");
  if (subs.length > 1) throw new AppError("VALIDATION_ERROR", "This subscriber has several subscriptions. Specify subscriptionId.");
  return subs[0]!.id;
}
