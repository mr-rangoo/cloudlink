import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { listWhere, requirePermission, tenantWhere, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { periodAt, type BillingUnit } from "@/server/domain/billing-period";
import { nextStatus, renewalContinues, type SubscriptionAction } from "@/server/domain/subscription-state";
import { actorType, actorUserId, lockRow, searchTerm } from "@/server/services/common";
import { queueSubscriberNotificationTx } from "@/server/services/notifications";
import { formatDate } from "@/lib/utils";
import type { Prisma, Subscription } from "@/generated/prisma/client";

export const subscriptionCreateInput = z.object({
  subscriberId: z.uuid(),
  packageId: z.uuid(),
  activate: z.boolean().default(true),
  /** Invoice the first period on activation (defaults to the organization billing setting). */
  invoice: z.boolean().optional(),
  graceDays: z.coerce.number().int().min(0).max(60).default(0),
  autoRenew: z.boolean().default(true),
});

export const subscriptionActionInput = z.object({
  reason: z.string().trim().max(500).optional(),
  /** For activate/renew: create the invoice for the new period (activate defaults to the org setting; renew defaults to true). */
  invoice: z.boolean().optional(),
});

export const subscriptionListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "EXPIRED", "CANCELLED", "ALL"]).default("ALL"),
  packageId: z.uuid().optional(),
  expiring: z.enum(["24h", "7d"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const subscriptionSelect = {
  id: true,
  subscriberId: true,
  packageId: true,
  branchId: true,
  status: true,
  packageName: true,
  serviceType: true,
  price: true,
  currency: true,
  taxRate: true,
  billingUnit: true,
  billingCount: true,
  periodIndex: true,
  billingAnchorAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  nextBillingAt: true,
  graceDays: true,
  autoRenew: true,
  activatedAt: true,
  suspendedAt: true,
  cancelledAt: true,
  createdAt: true,
} satisfies Prisma.SubscriptionSelect;

/**
 * Plans of a week or longer get expiry reminders and "service ended" messages. Short hotspot plans (minutes, hours,
 * a few days) would otherwise text the customer every time a plan runs out.
 */
export function remindable(sub: { billingUnit: BillingUnit; billingCount: number }): boolean {
  return sub.billingUnit === "YEAR" || sub.billingUnit === "MONTH" || sub.billingUnit === "WEEK" || (sub.billingUnit === "DAY" && sub.billingCount >= 7);
}

/**
 * Hourly: remind customers whose plan (a week or longer) ends within the organization's reminder window
 * (BillingSettings.expiryReminderDays; 0 = off). One reminder per subscription period.
 */
export async function remindExpiringSubscriptions(organizationId: string, now = new Date()): Promise<{ reminded: number }> {
  const settings = await db.billingSettings.findUnique({ where: { organizationId }, select: { expiryReminderDays: true } });
  const days = settings?.expiryReminderDays ?? 3;
  if (days <= 0) return { reminded: 0 };
  const tz = await orgTimezone(db, organizationId);
  const due = await db.subscription.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + days * 86_400_000) },
      OR: [{ billingUnit: { in: ["WEEK", "MONTH", "YEAR"] } }, { billingUnit: "DAY", billingCount: { gte: 7 } }],
    },
    select: { id: true, subscriberId: true, packageName: true, currentPeriodEnd: true },
    take: 1000,
  });
  let reminded = 0;
  for (const s of due) {
    const queued = await db.$transaction((tx) =>
      queueSubscriberNotificationTx(tx, organizationId, {
        subscriberId: s.subscriberId,
        key: "subscription.expiring",
        vars: { packageName: s.packageName, endDate: formatDate(s.currentPeriodEnd!, tz) },
        dedupeBase: `subscription.expiring:${s.id}:${s.currentPeriodEnd!.toISOString()}`,
      }),
    );
    if (queued) reminded++;
  }
  return { reminded };
}

async function orgTimezone(tx: Tx | typeof db, organizationId: string): Promise<string> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
  return org.timezone;
}

/** Create a subscription inside an existing transaction (used by subscriber onboarding and lead conversion). */
export async function createSubscriptionTx(tx: Tx, ctx: ActorContext, input: z.infer<typeof subscriptionCreateInput>) {
  const subscriber = await tx.subscriber.findFirst({ where: { id: input.subscriberId, ...tenantWhere(ctx) }, select: { id: true, branchId: true, status: true } });
  if (!subscriber) throw notFound("subscriber");
  if (subscriber.status === "ARCHIVED") throw new AppError("INVALID_STATE", "Archived subscribers cannot receive new subscriptions.");
  const pkg = await tx.package.findFirst({ where: { id: input.packageId, organizationId: ctx.organizationId } });
  if (!pkg) throw notFound("package");
  if (pkg.status !== "ACTIVE") throw new AppError("INVALID_STATE", "This package is not active and cannot be sold.");

  const sub = await tx.subscription.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: subscriber.branchId,
      subscriberId: subscriber.id,
      packageId: pkg.id,
      status: "PENDING",
      packageName: pkg.name,
      serviceType: pkg.serviceType,
      price: pkg.price,
      currency: pkg.currency,
      taxRate: pkg.taxRate,
      billingUnit: pkg.billingUnit,
      billingCount: pkg.billingCount,
      graceDays: input.graceDays,
      autoRenew: input.autoRenew,
    },
  });
  await tx.subscriptionEvent.create({
    data: { organizationId: ctx.organizationId, subscriptionId: sub.id, type: "created", toStatus: "PENDING", actorUserId: actorUserId(ctx), actorType: actorType(ctx), metadata: { packageId: pkg.id, price: pkg.price.toString() } },
  });
  await tx.subscriberActivity.create({
    data: { organizationId: ctx.organizationId, subscriberId: subscriber.id, actorUserId: actorUserId(ctx), type: "subscription.created", message: `Subscription to ${pkg.name} created`, metadata: { subscriptionId: sub.id } },
  });
  if (input.activate) return applyActionTx(tx, ctx, sub.id, "activate", { invoice: input.invoice });
  return sub;
}

export async function createSubscription(ctx: ActorContext, input: z.infer<typeof subscriptionCreateInput>) {
  requirePermission(ctx, "subscriptions.write");
  const sub = await db.$transaction((tx) => createSubscriptionTx(tx, ctx, input));
  await audit(ctx, { action: "subscription.create", entityType: "subscription", entityId: sub.id, metadata: { subscriberId: sub.subscriberId, packageId: sub.packageId, status: sub.status } });
  return sub;
}

const ACTION_LABEL: Record<SubscriptionAction, string> = {
  activate: "activated",
  renew: "renewed",
  suspend: "suspended",
  reactivate: "reactivated",
  cancel: "cancelled",
  expire: "expired",
};

/**
 * Apply a lifecycle action under a row lock. With an idempotency key, retries return the already-applied
 * result instead of applying twice (e.g. duplicate payment callbacks must not renew twice).
 */
export async function applyActionTx(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  action: SubscriptionAction,
  opts: { reason?: string; idempotencyKey?: string; now?: Date; invoice?: boolean; /** renew: start a fresh period now even if the current one is still running (plan switch). */ restart?: boolean },
): Promise<Subscription> {
  const existing = await tx.subscription.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true } });
  if (!existing) throw notFound("subscription");
  await lockRow(tx, "Subscription", id);
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id } });

  if (opts.idempotencyKey) {
    const prior = await tx.subscriptionEvent.findUnique({ where: { subscriptionId_idempotencyKey: { subscriptionId: id, idempotencyKey: opts.idempotencyKey } } });
    if (prior) return sub; // already applied
  }

  const to = nextStatus(sub.status, action);
  if (!to) throw new AppError("INVALID_STATE", `A ${sub.status.toLowerCase()} subscription cannot be ${ACTION_LABEL[action]}.`);

  const now = opts.now ?? new Date();
  const tz = await orgTimezone(tx, sub.organizationId);
  const data: Prisma.SubscriptionUpdateInput = { status: to };

  if (action === "activate" || action === "renew") {
    let anchor: Date;
    let index: number;
    if (action === "renew" && !opts.restart && renewalContinues(sub.status, sub.currentPeriodEnd, now) && sub.billingAnchorAt) {
      anchor = sub.billingAnchorAt;
      index = sub.periodIndex + 1;
    } else {
      anchor = now;
      index = 0;
    }
    const period = periodAt(anchor, sub.billingUnit, sub.billingCount, index, tz);
    Object.assign(data, {
      billingAnchorAt: anchor,
      periodIndex: index,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      nextBillingAt: period.end,
      suspendedAt: null,
      activatedAt: sub.activatedAt ?? now,
    });
  } else if (action === "suspend") {
    data.suspendedAt = now;
  } else if (action === "reactivate") {
    if (!sub.currentPeriodEnd || sub.currentPeriodEnd <= now) {
      throw new AppError("INVALID_STATE", "The paid period has ended. Renew the subscription instead of reactivating it.");
    }
    data.suspendedAt = null;
  } else if (action === "cancel") {
    data.cancelledAt = now;
    data.nextBillingAt = null;
    data.autoRenew = false;
  } else if (action === "expire") {
    data.nextBillingAt = sub.autoRenew ? sub.nextBillingAt : null;
  }

  let updated = await tx.subscription.update({ where: { id }, data });
  if (updated.networkRouterId) {
    // Network access follows the billing status through a durable network operation (separate status).
    const { queueLifecycleNetworkTx } = await import("@/server/services/network");
    if (await queueLifecycleNetworkTx(tx, ctx, sub, updated)) updated = await tx.subscription.findUniqueOrThrow({ where: { id } });
  }
  await tx.subscriptionEvent.create({
    data: {
      organizationId: sub.organizationId,
      subscriptionId: id,
      type: ACTION_LABEL[action],
      fromStatus: sub.status,
      toStatus: to,
      actorUserId: actorUserId(ctx),
      actorType: actorType(ctx),
      idempotencyKey: opts.idempotencyKey ?? null,
      metadata: {
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(updated.currentPeriodEnd ? { periodStart: updated.currentPeriodStart?.toISOString(), periodEnd: updated.currentPeriodEnd.toISOString() } : {}),
      },
    },
  });
  if (action === "expire" && sub.currentPeriodEnd && remindable(sub)) {
    await queueSubscriberNotificationTx(tx, sub.organizationId, {
      subscriberId: sub.subscriberId,
      key: "subscription.expired",
      vars: { packageName: sub.packageName, endDate: formatDate(sub.currentPeriodEnd, tz) },
      dedupeBase: `subscription.expired:${id}:${sub.currentPeriodEnd.toISOString()}`,
    });
  }
  await tx.subscriberActivity.create({
    data: {
      organizationId: sub.organizationId,
      subscriberId: sub.subscriberId,
      actorUserId: actorUserId(ctx),
      type: `subscription.${ACTION_LABEL[action]}`,
      message: `${sub.packageName} subscription ${ACTION_LABEL[action]}${opts.reason ? `: ${opts.reason}` : ""}`,
      metadata: { subscriptionId: id },
    },
  });
  if ((action === "activate" || action === "renew") && updated.currentPeriodStart && updated.currentPeriodEnd) {
    let invoice = opts.invoice;
    if (invoice === undefined && action === "activate") {
      const settings = await tx.billingSettings.findUnique({ where: { organizationId: sub.organizationId } });
      invoice = settings?.invoiceOnActivation ?? true;
    }
    if (invoice) {
      // Imported lazily: invoices → settlement → subscriptions would otherwise form an import cycle.
      const { createPeriodInvoiceTx } = await import("@/server/services/invoices");
      await createPeriodInvoiceTx(tx, ctx, updated, { start: updated.currentPeriodStart, end: updated.currentPeriodEnd }, action === "activate" ? "activation" : "renewal");
      return tx.subscription.findUniqueOrThrow({ where: { id } });
    }
  }
  return updated;
}

export const compensateInput = z.object({
  amount: z.coerce.number().int().min(1).max(2160),
  unit: z.enum(["HOUR", "DAY"]),
  reason: z.string().trim().min(3, "Say why (e.g. the outage)").max(300),
});

export const MAX_COMPENSATION_MS = 90 * 86_400_000;

/**
 * Free time after an outage: the paid period is extended and billing is re-anchored at the new end
 * (periodIndex -1), so renewals and recurring invoices continue from it. No money moves. Hotspot logins get the
 * longer period pushed to the router. Data bundles are refused (time does not compensate a data allowance).
 */
export async function compensateSubscription(ctx: ActorContext, id: string, raw: z.input<typeof compensateInput>) {
  requirePermission(ctx, "subscriptions.write");
  const input = compensateInput.parse(raw);
  const ms = input.amount * (input.unit === "DAY" ? 86_400_000 : 3_600_000);
  if (ms > MAX_COMPENSATION_MS) throw new AppError("VALIDATION_ERROR", "Compensation is limited to 90 days at a time.", { fields: [{ path: "amount", message: "At most 90 days" }] });
  const label = `${input.amount} ${input.unit === "DAY" ? "day" : "hour"}${input.amount === 1 ? "" : "s"}`;
  const result = await db.$transaction(async (tx) => {
    const existing = await tx.subscription.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true } });
    if (!existing) throw notFound("subscription");
    await lockRow(tx, "Subscription", id);
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id } });
    if ((sub.status !== "ACTIVE" && sub.status !== "SUSPENDED") || !sub.currentPeriodEnd || !sub.billingAnchorAt) {
      throw new AppError("INVALID_STATE", "Only active or suspended subscriptions with a paid period can be compensated.");
    }
    const pkg = await tx.package.findUnique({ where: { id: sub.packageId }, select: { kind: true } });
    if (pkg?.kind === "DATA") throw new AppError("INVALID_STATE", "Data bundles cannot be compensated with extra time.");
    const newEnd = new Date(sub.currentPeriodEnd.getTime() + ms);
    let after = await tx.subscription.update({ where: { id }, data: { currentPeriodEnd: newEnd, billingAnchorAt: newEnd, periodIndex: -1, nextBillingAt: sub.nextBillingAt ? newEnd : null } });
    if (after.networkRouterId) {
      const { queueLifecycleNetworkTx } = await import("@/server/services/network");
      if (await queueLifecycleNetworkTx(tx, ctx, sub, after)) after = await tx.subscription.findUniqueOrThrow({ where: { id } });
    }
    await tx.subscriptionEvent.create({
      data: {
        organizationId: sub.organizationId,
        subscriptionId: id,
        type: "compensated",
        fromStatus: sub.status,
        toStatus: sub.status,
        actorUserId: actorUserId(ctx),
        actorType: actorType(ctx),
        metadata: { amount: input.amount, unit: input.unit, reason: input.reason, previousEnd: sub.currentPeriodEnd.toISOString(), periodEnd: newEnd.toISOString() },
      },
    });
    await tx.subscriberActivity.create({
      data: {
        organizationId: sub.organizationId,
        subscriberId: sub.subscriberId,
        actorUserId: actorUserId(ctx),
        type: "subscription.compensated",
        message: `${sub.packageName}: ${label} added free (${input.reason})`,
        metadata: { subscriptionId: id },
      },
    });
    return { after, previousEnd: sub.currentPeriodEnd };
  });
  await dispatchSubscriptionNetwork(ctx.organizationId, id);
  await audit(ctx, { action: "subscription.compensate", entityType: "subscription", entityId: id, metadata: { amount: input.amount, unit: input.unit, reason: input.reason, previousEnd: result.previousEnd.toISOString(), periodEnd: result.after.currentPeriodEnd?.toISOString() } });
  return result.after;
}

/** After commit: push any network operation queued by the lifecycle hook (the worker sweeper is the fallback). */
export async function dispatchSubscriptionNetwork(organizationId: string, subscriptionId: string) {
  const { dispatchNetworkOperations } = await import("@/server/services/network");
  await dispatchNetworkOperations(organizationId, { subscriptionId });
}

const ACTION_PERMISSION = "subscriptions.write" as const;

export async function applySubscriptionAction(ctx: ActorContext, id: string, action: Exclude<SubscriptionAction, "expire">, opts: { reason?: string; idempotencyKey?: string; invoice?: boolean } = {}) {
  requirePermission(ctx, ACTION_PERMISSION);
  if (opts.invoice) requirePermission(ctx, "invoices.issue");
  const before = await db.subscription.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { status: true } });
  if (!before) throw notFound("subscription");
  const sub = await db.$transaction((tx) => applyActionTx(tx, ctx, id, action, opts));
  await dispatchSubscriptionNetwork(ctx.organizationId, id);
  await audit(ctx, { action: `subscription.${action}`, entityType: "subscription", entityId: id, metadata: { from: before.status, to: sub.status, reason: opts.reason, invoice: opts.invoice } });
  return sub;
}

export async function listSubscriptions(ctx: ActorContext, query: z.infer<typeof subscriptionListQuery>) {
  requirePermission(ctx, "subscriptions.read");
  const q = searchTerm(query.q);
  const where: Prisma.SubscriptionWhereInput = {
    ...listWhere(ctx),
    ...(query.status !== "ALL" ? { status: query.status } : {}),
    ...(query.packageId ? { packageId: query.packageId } : {}),
    ...(query.expiring ? { status: "ACTIVE", currentPeriodEnd: { lte: new Date(Date.now() + (query.expiring === "24h" ? 1 : 7) * 86_400_000) } } : {}),
    ...(q
      ? {
          OR: [
            { packageName: { contains: q, mode: "insensitive" } },
            { subscriber: { displayName: { contains: q, mode: "insensitive" } } },
            { subscriber: { accountNumber: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.subscription.findMany({
      where,
      select: { ...subscriptionSelect, subscriber: { select: { id: true, displayName: true, accountNumber: true } } },
      orderBy: [{ createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    db.subscription.count({ where }),
  ]);
  return { rows, total };
}

export async function getSubscription(ctx: ActorContext, id: string) {
  requirePermission(ctx, "subscriptions.read");
  const sub = await db.subscription.findFirst({
    where: { id, ...tenantWhere(ctx) },
    select: {
      ...subscriptionSelect,
      subscriber: { select: { id: true, displayName: true, accountNumber: true } },
      events: { orderBy: { createdAt: "desc" }, take: 50, select: { id: true, type: true, fromStatus: true, toStatus: true, actorType: true, actorUserId: true, metadata: true, createdAt: true } },
    },
  });
  if (!sub) throw notFound("subscription");
  return sub;
}

/**
 * System job: expire ACTIVE/SUSPENDED subscriptions whose paid period plus grace has elapsed.
 * Each subscription is expired in its own transaction via the state machine.
 */
export async function expireDueSubscriptions(organizationId: string, ctx: ActorContext, now = new Date()): Promise<number> {
  const due = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Subscription"
    WHERE "organizationId" = ${organizationId}::uuid
      AND "status" IN ('ACTIVE', 'SUSPENDED')
      AND "currentPeriodEnd" IS NOT NULL
      AND "currentPeriodEnd" + make_interval(days => "graceDays") <= ${now}
      -- Never cut off a customer whose payment is still being processed (APP_FLOW: unresolved payment states).
      AND NOT EXISTS (
        SELECT 1 FROM "PaymentAttempt" pa
        WHERE pa."subscriberId" = "Subscription"."subscriberId"
          AND ((pa."status" IN ('PENDING', 'SUBMITTED') AND pa."createdAt" > ${new Date(now.getTime() - 30 * 60_000)})
            OR (pa."status" = 'UNKNOWN' AND pa."createdAt" > ${new Date(now.getTime() - 24 * 3_600_000)}))
      )
    LIMIT 500`;
  let count = 0;
  for (const { id } of due) {
    await db.$transaction((tx) => applyActionTx(tx, ctx, id, "expire", { now, idempotencyKey: undefined }));
    await dispatchSubscriptionNetwork(organizationId, id);
    count++;
  }
  return count;
}
