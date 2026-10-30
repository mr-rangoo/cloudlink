import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { requirePermission, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { enqueueOperation, PermanentError } from "@/server/jobs/operations";
import { messagingAdapterForOrg } from "@/server/services/messaging-config";
import type { NotificationChannel, Prisma } from "@/generated/prisma/client";

/**
 * Notifications: rendered from per-organization templates, gated by subscriber preferences, written as QUEUED rows
 * inside the business transaction (outbox), and delivered by the worker through messaging adapters.
 * A row only becomes SENT when the adapter accepts it; mock adapters mark it `simulated`.
 */
export type TemplateKey =
  | "invoice.issued"
  | "payment.received"
  | "credit.saved"
  | "ticket.reply"
  | "ticket.resolved"
  | "portal.invite"
  | "subscriber.welcome"
  | "subscription.expiring"
  | "subscription.expired"
  | "hotspot.purchased"
  | "voucher.delivery";
export type Category = "billing" | "service" | "support" | "account";

export const TEMPLATE_CATEGORY: Record<TemplateKey, Category> = {
  "invoice.issued": "billing",
  "payment.received": "billing",
  "credit.saved": "billing",
  "ticket.reply": "support",
  "ticket.resolved": "support",
  "portal.invite": "account",
  "subscriber.welcome": "account",
  "subscription.expiring": "service",
  "subscription.expired": "service",
  "hotspot.purchased": "service",
  // Sent only when staff deliver a voucher on purpose, so it is not subject to preferences.
  "voucher.delivery": "account",
};

export const TEMPLATE_VARIABLES: Record<TemplateKey, string[]> = {
  "invoice.issued": ["name", "organization", "invoiceNumber", "amount", "dueDate", "accountNumber"],
  "payment.received": ["name", "organization", "amount", "receiptNumber", "accountNumber", "balance"],
  "credit.saved": ["name", "organization", "amount", "credit", "accountNumber"],
  "ticket.reply": ["name", "organization", "ticketNumber", "subject", "message"],
  "ticket.resolved": ["name", "organization", "ticketNumber", "subject", "resolution"],
  "portal.invite": ["name", "organization", "link", "accountNumber"],
  "subscription.expiring": ["name", "organization", "packageName", "endDate", "accountNumber"],
  "subscriber.welcome": ["name", "organization", "accountNumber"],
  "subscription.expired": ["name", "organization", "packageName", "endDate", "accountNumber"],
  "hotspot.purchased": ["name", "organization", "packageName", "endDate", "receipt"],
  "voucher.delivery": ["organization", "code", "packageName", "validUntil"],
};

const DEFAULTS: Record<TemplateKey, { subject: string; sms: string; email: string }> = {
  "invoice.issued": {
    subject: "Invoice {{invoiceNumber}} from {{organization}}",
    sms: "{{organization}}: Invoice {{invoiceNumber}} of {{amount}} is due {{dueDate}}. Pay with account {{accountNumber}}.",
    email: "Hello {{name}},\n\nInvoice {{invoiceNumber}} for {{amount}} has been issued and is due on {{dueDate}}.\nUse your account number {{accountNumber}} as the payment reference.\n\n{{organization}}",
  },
  "payment.received": {
    subject: "Payment received — {{receiptNumber}}",
    sms: "{{organization}}: We received {{amount}} (receipt {{receiptNumber}}). Account {{accountNumber}} balance: {{balance}}. Thank you.",
    email: "Hello {{name}},\n\nWe received your payment of {{amount}}. Receipt: {{receiptNumber}}.\nYour account balance is now {{balance}}.\n\nThank you,\n{{organization}}",
  },
  "ticket.reply": {
    subject: "Update on ticket {{ticketNumber}}",
    sms: "{{organization}}: New reply on ticket {{ticketNumber}}. Log in to the customer portal to read it.",
    email: "Hello {{name}},\n\nThere is a new reply on your ticket {{ticketNumber}} ({{subject}}):\n\n{{message}}\n\n{{organization}} support",
  },
  "ticket.resolved": {
    subject: "Ticket {{ticketNumber}} resolved",
    sms: "{{organization}}: Ticket {{ticketNumber}} has been resolved. Reply in the portal if the problem continues.",
    email: "Hello {{name}},\n\nYour ticket {{ticketNumber}} ({{subject}}) has been resolved:\n\n{{resolution}}\n\nReply in the customer portal if the problem continues.\n\n{{organization}} support",
  },
  "portal.invite": {
    subject: "Your {{organization}} customer portal access",
    sms: "{{organization}}: Set up your customer portal password: {{link}} (valid 72 hours).",
    email: "Hello {{name}},\n\nYou can now view invoices, payments and support tickets online.\nSet your password here (valid for 72 hours): {{link}}\n\nYour account number is {{accountNumber}}.\n\n{{organization}}",
  },
  "subscription.expiring": {
    subject: "Your {{packageName}} service ends {{endDate}}",
    sms: "{{organization}}: Your {{packageName}} service ends {{endDate}}. Pay with account {{accountNumber}} to stay connected.",
    email: "Hello {{name}},\n\nYour {{packageName}} service is paid until {{endDate}}.\nPay with account number {{accountNumber}} to avoid interruption.\n\n{{organization}}",
  },
  "credit.saved": {
    subject: "{{credit}} saved on your account",
    sms: "{{organization}}: {{credit}} of your {{amount}} payment is saved as credit on account {{accountNumber}}. It will pay your next bill.",
    email: "Hello {{name}},\n\nFrom your payment of {{amount}}, {{credit}} is saved as credit on account {{accountNumber}}.\nIt will be used for your next invoice automatically.\n\n{{organization}}",
  },
  "subscriber.welcome": {
    subject: "Welcome to {{organization}}",
    sms: "Welcome to {{organization}}, {{name}}! Your account number is {{accountNumber}}. Use it as the reference when you pay.",
    email: "Hello {{name}},\n\nWelcome to {{organization}}. Your account number is {{accountNumber}}.\nUse it as the payment reference (M-Pesa account number) whenever you pay.\n\n{{organization}}",
  },
  "subscription.expired": {
    subject: "Your {{packageName}} service has ended",
    sms: "{{organization}}: Your {{packageName}} service ended {{endDate}}. Pay with account {{accountNumber}} to reconnect.",
    email: "Hello {{name}},\n\nYour {{packageName}} service ended on {{endDate}}.\nPay with account number {{accountNumber}} and it will be restored automatically.\n\n{{organization}}",
  },
  "hotspot.purchased": {
    subject: "{{packageName}} is active",
    sms: "{{organization}}: {{packageName}} is active until {{endDate}}. To connect another device, choose \"Already paid\" on the Wi-Fi page and enter M-Pesa code {{receipt}}.",
    email: "Hello,\n\n{{packageName}} is active until {{endDate}}.\nTo connect another device, choose \"Already paid\" on the Wi-Fi page and enter your M-Pesa code {{receipt}}.\n\n{{organization}}",
  },
  "voucher.delivery": {
    subject: "Your {{organization}} Wi-Fi voucher",
    sms: "{{organization}}: Your Wi-Fi voucher code is {{code}} ({{packageName}}). Use it by {{validUntil}}.",
    email: "Hello,\n\nYour Wi-Fi voucher code is {{code}} ({{packageName}}).\nEnter it on the Wi-Fi login page by {{validUntil}}.\n\n{{organization}}",
  },
};

/** Plain-text rendering; unknown placeholders are left visible so template mistakes are noticed. */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

async function templateFor(client: Tx | typeof db, organizationId: string, key: TemplateKey, channel: NotificationChannel) {
  const row = await client.notificationTemplate.findUnique({ where: { organizationId_key_channel: { organizationId, key, channel } } });
  if (row) return row.active ? { subject: row.subject, body: row.body } : null;
  const d = DEFAULTS[key];
  return { subject: channel === "EMAIL" ? d.subject : null, body: channel === "EMAIL" ? d.email : d.sms };
}

export async function preferenceAllows(client: Tx | typeof db, subscriberId: string, channel: NotificationChannel, category: Category): Promise<boolean> {
  if (category === "account") return true; // account/security messages cannot be switched off
  const pref = await client.notificationPreference.findUnique({ where: { subscriberId_channel_category: { subscriberId, channel, category } } });
  return pref?.enabled ?? true;
}

/**
 * Queue a notification to a subscriber on every channel they can receive (SMS to phone, email if present).
 * Idempotent per dedupeBase + channel. Must be called inside the business transaction (outbox pattern).
 */
export async function queueSubscriberNotificationTx(
  tx: Tx,
  organizationId: string,
  input: { subscriberId: string; key: TemplateKey; vars: Record<string, string | number | null | undefined>; dedupeBase: string; channels?: NotificationChannel[] },
): Promise<number> {
  const subscriber = await tx.subscriber.findUnique({ where: { id: input.subscriberId }, select: { displayName: true, phone: true, email: true, accountNumber: true, organizationId: true } });
  if (!subscriber || subscriber.organizationId !== organizationId) return 0;
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
  const vars = { name: subscriber.displayName, organization: org.name, accountNumber: subscriber.accountNumber, ...input.vars };
  const category = TEMPLATE_CATEGORY[input.key];
  const targets: Array<{ channel: NotificationChannel; recipient: string }> = [];
  if (subscriber.phone) targets.push({ channel: "SMS", recipient: subscriber.phone });
  if (subscriber.email) targets.push({ channel: "EMAIL", recipient: subscriber.email });

  let queued = 0;
  for (const t of targets) {
    if (input.channels && !input.channels.includes(t.channel)) continue;
    const dedupeKey = `${input.dedupeBase}:${t.channel}`;
    if (await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } })) continue;
    const tpl = await templateFor(tx, organizationId, input.key, t.channel);
    const allowed = tpl !== null && (await preferenceAllows(tx, input.subscriberId, t.channel, category));
    const n = await tx.notification.create({
      data: {
        organizationId,
        subscriberId: input.subscriberId,
        channel: t.channel,
        templateKey: input.key,
        category,
        recipient: t.recipient,
        subject: tpl?.subject ? renderTemplate(tpl.subject, vars) : null,
        body: tpl ? renderTemplate(tpl.body, vars) : "",
        status: allowed ? "QUEUED" : "SKIPPED",
        lastError: allowed ? null : tpl === null ? "TEMPLATE_DISABLED" : "OPTED_OUT",
        dedupeKey,
      },
    });
    if (allowed) {
      await enqueueOperation({ type: "notifications.send", organizationId, payload: { notificationId: n.id }, dedupeKey: `notify:${n.id}`, maxAttempts: 5 }, tx);
      queued++;
    }
  }
  return queued;
}

/**
 * Queue one message to a given recipient (not necessarily a subscriber), e.g. a voucher code for a walk-in
 * customer. Idempotent per dedupeKey; written in the caller's transaction like every other notification.
 */
export async function queueNotificationTx(
  tx: Tx,
  organizationId: string,
  input: { channel: NotificationChannel; recipient: string; key: TemplateKey; vars: Record<string, string | number | null | undefined>; dedupeKey: string; subscriberId?: string | null; metadata?: Prisma.InputJsonValue },
) {
  const existing = await tx.notification.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (existing) return existing;
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
  const tpl = await templateFor(tx, organizationId, input.key, input.channel);
  const vars = { organization: org.name, ...input.vars };
  const n = await tx.notification.create({
    data: {
      organizationId,
      subscriberId: input.subscriberId ?? null,
      channel: input.channel,
      templateKey: input.key,
      category: TEMPLATE_CATEGORY[input.key],
      recipient: input.recipient,
      subject: tpl?.subject ? renderTemplate(tpl.subject, vars) : null,
      body: tpl ? renderTemplate(tpl.body, vars) : "",
      status: tpl ? "QUEUED" : "SKIPPED",
      lastError: tpl ? null : "TEMPLATE_DISABLED",
      dedupeKey: input.dedupeKey,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
  });
  if (tpl) await enqueueOperation({ type: "notifications.send", organizationId, payload: { notificationId: n.id }, dedupeKey: `notify:${n.id}`, maxAttempts: 5 }, tx);
  return n;
}

/**
 * Worker handler: deliver one notification through the organization's provider (see messaging-config).
 * Missing configuration → SKIPPED (never "sent"). Transient failures are retried by the operation runner;
 * permanent failures mark FAILED.
 */
export async function deliverNotification(notificationId: string, overrideBody?: (n: { body: string }) => Promise<{ send: string; store: string }>): Promise<void> {
  const n = await db.notification.findUnique({ where: { id: notificationId } });
  if (!n || n.status !== "QUEUED") return;
  const { adapter } = await messagingAdapterForOrg(n.organizationId, n.channel);
  if (!adapter.available) {
    await db.notification.update({ where: { id: n.id }, data: { status: "SKIPPED", lastError: `${n.channel}_NOT_CONFIGURED`, provider: adapter.provider } });
    return;
  }
  await db.notification.update({ where: { id: n.id }, data: { attempts: { increment: 1 } } });
  try {
    const bodies = overrideBody ? await overrideBody(n) : { send: n.body, store: n.body };
    const result = await adapter.send({ to: n.recipient, subject: n.subject, body: bodies.send });
    await db.notification.update({
      where: { id: n.id },
      data: { status: "SENT", sentAt: new Date(), provider: adapter.provider, providerMessageId: result.providerMessageId, simulated: result.simulated, lastError: null, body: bodies.store },
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "SEND_FAILED";
    if (err instanceof PermanentError) {
      await db.notification.update({ where: { id: n.id }, data: { status: "FAILED", lastError: code, provider: adapter.provider } });
      return;
    }
    await db.notification.update({ where: { id: n.id }, data: { lastError: code, provider: adapter.provider } });
    throw err; // retryable: the operation runner backs off and retries
  }
}

// ───────── Staff-facing queries and template management ─────────

export const notificationListQuery = z.object({
  status: z.enum(["QUEUED", "SENT", "DELIVERED", "FAILED", "SKIPPED", "ALL"]).default("ALL"),
  subscriberId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listNotifications(ctx: ActorContext, query: z.infer<typeof notificationListQuery>) {
  requirePermission(ctx, "notifications.read");
  const where: Prisma.NotificationWhereInput = { organizationId: ctx.organizationId, ...(query.status !== "ALL" ? { status: query.status } : {}), ...(query.subscriberId ? { subscriberId: query.subscriberId } : {}) };
  const [rows, total] = await Promise.all([
    db.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.notification.count({ where }),
  ]);
  return { rows, total };
}

export const templateInput = z.object({
  key: z.enum(Object.keys(TEMPLATE_CATEGORY) as [TemplateKey, ...TemplateKey[]]),
  channel: z.enum(["EMAIL", "SMS"]),
  subject: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().min(5).max(1600),
  active: z.boolean().default(true),
});

export async function listTemplates(ctx: ActorContext) {
  requirePermission(ctx, "notifications.read");
  const rows = await db.notificationTemplate.findMany({ where: { organizationId: ctx.organizationId } });
  const keys = Object.keys(DEFAULTS) as TemplateKey[];
  return keys.flatMap((key) =>
    (["SMS", "EMAIL"] as const).map((channel) => {
      const row = rows.find((r) => r.key === key && r.channel === channel);
      const d = DEFAULTS[key];
      return {
        key,
        channel,
        category: TEMPLATE_CATEGORY[key],
        variables: TEMPLATE_VARIABLES[key],
        customised: Boolean(row),
        active: row?.active ?? true,
        subject: row ? row.subject : channel === "EMAIL" ? d.subject : null,
        body: row ? row.body : channel === "EMAIL" ? d.email : d.sms,
      };
    }),
  );
}

export async function saveTemplate(ctx: ActorContext, input: z.infer<typeof templateInput>) {
  requirePermission(ctx, "notifications.write");
  if (input.key === "portal.invite" && !input.body.includes("{{link}}")) {
    throw new AppError("VALIDATION_ERROR", "The portal invite must include {{link}}.", { fields: [{ path: "body", message: "Must include {{link}}" }] });
  }
  if (input.key === "voucher.delivery" && !input.body.includes("{{code}}")) {
    throw new AppError("VALIDATION_ERROR", "The voucher message must include {{code}}.", { fields: [{ path: "body", message: "Must include {{code}}" }] });
  }
  if (input.channel === "SMS" && input.body.length > 480) throw new AppError("VALIDATION_ERROR", "SMS templates must be 480 characters or fewer.", { fields: [{ path: "body", message: "Too long for SMS" }] });
  const row = await db.notificationTemplate.upsert({
    where: { organizationId_key_channel: { organizationId: ctx.organizationId, key: input.key, channel: input.channel } },
    update: { subject: input.subject ?? null, body: input.body, active: input.active },
    create: { organizationId: ctx.organizationId, key: input.key, channel: input.channel, subject: input.subject ?? null, body: input.body, active: input.active },
  });
  await audit(ctx, { action: "notification_template.save", entityType: "notification_template", entityId: row.id, metadata: { key: input.key, channel: input.channel, active: input.active } });
  return row;
}

export async function getPreferences(organizationId: string, subscriberId: string) {
  const rows = await db.notificationPreference.findMany({ where: { organizationId, subscriberId } });
  return (["billing", "service", "support"] as const).flatMap((category) =>
    (["SMS", "EMAIL"] as const).map((channel) => ({ category, channel, enabled: rows.find((r) => r.category === category && r.channel === channel)?.enabled ?? true })),
  );
}

export const preferencesInput = z.object({
  preferences: z.array(z.object({ category: z.enum(["billing", "service", "support"]), channel: z.enum(["EMAIL", "SMS"]), enabled: z.boolean() })).min(1).max(6),
});

export async function savePreferences(organizationId: string, subscriberId: string, input: z.infer<typeof preferencesInput>) {
  for (const p of input.preferences) {
    await db.notificationPreference.upsert({
      where: { subscriberId_channel_category: { subscriberId, channel: p.channel, category: p.category } },
      update: { enabled: p.enabled },
      create: { organizationId, subscriberId, channel: p.channel, category: p.category, enabled: p.enabled },
    });
  }
  return getPreferences(organizationId, subscriberId);
}

export async function retryNotification(ctx: ActorContext, id: string) {
  requirePermission(ctx, "notifications.write");
  const n = await db.notification.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!n) throw notFound("notification");
  if (n.status !== "FAILED" && n.status !== "SKIPPED") throw new AppError("INVALID_STATE", "Only failed or skipped notifications can be retried.");
  if (n.templateKey === "portal.invite") throw new AppError("INVALID_STATE", "Send a new portal invite instead.");
  await db.$transaction(async (tx) => {
    await tx.notification.update({ where: { id }, data: { status: "QUEUED", lastError: null } });
    await enqueueOperation({ type: "notifications.send", organizationId: ctx.organizationId, payload: { notificationId: id }, dedupeKey: `notify:${id}:retry:${Date.now()}`, maxAttempts: 5 }, tx);
  });
  await audit(ctx, { action: "notification.retry", entityType: "notification", entityId: id });
}
