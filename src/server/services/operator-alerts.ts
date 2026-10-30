import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/server/errors";
import { normalizePhone } from "@/server/domain/contact";
import { addLocalDays, localDateKey, startOfLocalDay, toWallTime } from "@/server/domain/time";
import { queueNotificationTx } from "@/server/services/notifications";
import { formatMoney } from "@/lib/utils";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Operator alerts: SMS/email to the people an organization chooses when something needs attention — a router goes
 * offline, a network change fails, a payment arrives that matches no subscriber — plus an optional daily digest.
 * Messages are ordinary notifications (outbox, retries, simulated in mock mode) without a subscriber.
 */
export const OPERATOR_EVENTS = ["router_offline", "operation_failed", "payment_unmatched", "service_request", "daily_digest"] as const;
export type OperatorEvent = (typeof OPERATOR_EVENTS)[number];
export const OPERATOR_EVENT_LABEL: Record<OperatorEvent, string> = {
  router_offline: "A router stops answering health checks",
  operation_failed: "A network change fails after its retries",
  payment_unmatched: "A payment arrives that matches no subscriber",
  service_request: "Someone asks for a connection on the customer portal",
  daily_digest: "Daily summary",
};

const recipient = z.object({ channel: z.enum(["SMS", "EMAIL"]), to: z.string().trim().min(3).max(200), label: z.string().trim().max(60).optional().nullable() });

export const operatorAlertInput = z.object({
  recipients: z.array(recipient).max(10),
  events: z.array(z.enum(OPERATOR_EVENTS)).max(OPERATOR_EVENTS.length),
  digestHour: z.coerce.number().int().min(0).max(23).default(7),
});

type Recipient = z.infer<typeof recipient>;

export async function getOperatorAlertSettings(ctx: StaffContext) {
  requirePermission(ctx, "settings.write");
  const row = await db.operatorAlertSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  return { recipients: (row?.recipients ?? []) as Recipient[], events: (row?.events ?? []) as OperatorEvent[], digestHour: row?.digestHour ?? 7 };
}

export async function saveOperatorAlertSettings(ctx: StaffContext, raw: z.input<typeof operatorAlertInput>) {
  requirePermission(ctx, "settings.write");
  const input = operatorAlertInput.parse(raw);
  const recipients = input.recipients.map((r, i) => {
    const to = r.channel === "SMS" ? normalizePhone(r.to) : z.email().safeParse(r.to).success ? r.to.toLowerCase() : null;
    if (!to) throw new AppError("VALIDATION_ERROR", r.channel === "SMS" ? `Recipient ${i + 1}: enter a Kenyan mobile number.` : `Recipient ${i + 1}: enter an email address.`, { fields: [{ path: `recipients.${i}.to`, message: "Invalid" }] });
    return { channel: r.channel, to, label: r.label ?? null };
  });
  const unique = recipients.filter((r, i) => recipients.findIndex((x) => x.channel === r.channel && x.to === r.to) === i);
  const data = { recipients: unique as Prisma.InputJsonValue, events: [...new Set(input.events)] as Prisma.InputJsonValue, digestHour: input.digestHour };
  await db.operatorAlertSettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
  await audit(ctx, { action: "operator_alerts.save", entityType: "organization", entityId: ctx.organizationId, metadata: { recipients: unique.length, events: input.events, digestHour: input.digestHour } });
  return getOperatorAlertSettings(ctx);
}

async function settingsFor(organizationId: string) {
  const row = await db.operatorAlertSettings.findUnique({ where: { organizationId } });
  return row ? { recipients: row.recipients as Recipient[], events: row.events as OperatorEvent[], digestHour: row.digestHour } : null;
}

/**
 * Tell the chosen people about an event (once per `dedupe` and recipient). Never throws into the caller's flow:
 * an alert that cannot be queued must not break a health check or a payment.
 */
export async function notifyOperators(organizationId: string, event: Exclude<OperatorEvent, "daily_digest">, message: string, dedupe: string): Promise<number> {
  const settings = await settingsFor(organizationId);
  if (!settings?.events.includes(event) || !settings.recipients.length) return 0;
  let queued = 0;
  await db.$transaction(async (tx) => {
    for (const r of settings.recipients) {
      const { notification, created } = await queueNotificationTx(tx, organizationId, { channel: r.channel, recipient: r.to, key: "operator.alert", vars: { message: message.slice(0, 300) }, dedupeKey: `operator:${dedupe}:${r.channel}:${r.to}` });
      if (created && notification.status === "QUEUED") queued++;
    }
  });
  return queued;
}

/**
 * Hourly: at the organization's digest hour (local time), send yesterday's summary once.
 * Collected = CONFIRMED payments in the organization currency; expiring tomorrow = ACTIVE plans ending tomorrow.
 */
export async function sendDailyDigest(organizationId: string, now = new Date()): Promise<{ sent: number }> {
  const settings = await settingsFor(organizationId);
  if (!settings?.events.includes("daily_digest") || !settings.recipients.length) return { sent: 0 };
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true, currency: true } });
  if (toWallTime(now, org.timezone).hour !== settings.digestHour) return { sent: 0 };
  const today = startOfLocalDay(now, org.timezone);
  const yesterday = addLocalDays(today, -1, org.timezone);
  const tomorrow = addLocalDays(today, 1, org.timezone);
  const dayAfter = addLocalDays(today, 2, org.timezone);
  const [collected, newSubscribers, expiring, offline, tickets] = await Promise.all([
    db.payment.aggregate({ where: { organizationId, status: "CONFIRMED", currency: org.currency, receivedAt: { gte: yesterday, lt: today } }, _sum: { amount: true }, _count: { _all: true } }),
    db.subscriber.count({ where: { organizationId, createdAt: { gte: yesterday, lt: today } } }),
    db.subscription.count({ where: { organizationId, status: "ACTIVE", currentPeriodEnd: { gte: tomorrow, lt: dayAfter } } }),
    db.router.count({ where: { organizationId, archivedAt: null, status: { in: ["OFFLINE", "ERROR"] } } }),
    db.supportTicket.count({ where: { organizationId, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER"] } } }),
  ]);
  const date = localDateKey(yesterday, org.timezone);
  const vars = {
    date,
    collected: formatMoney((collected._sum.amount ?? 0).toString(), org.currency),
    payments: collected._count._all,
    newSubscribers,
    expiringTomorrow: expiring,
    routersOffline: offline,
    openTickets: tickets,
  };
  let sent = 0;
  await db.$transaction(async (tx) => {
    for (const r of settings.recipients) {
      const { notification, created } = await queueNotificationTx(tx, organizationId, { channel: r.channel, recipient: r.to, key: "operator.digest", vars, dedupeKey: `operator-digest:${organizationId}:${date}:${r.channel}:${r.to}` });
      if (created && notification.status === "QUEUED") sent++;
    }
  });
  return { sent };
}
