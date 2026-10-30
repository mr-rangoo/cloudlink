import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { requirePermission, systemContext, type ActorContext, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { dispatchOperation, enqueueOperation, PermanentError } from "@/server/jobs/operations";
import { subscriberFilterWhere, subscriberListQuery, type SubscriberFilters } from "@/server/services/subscribers";
import { preferenceAllows, renderTemplate } from "@/server/services/notifications";
import { formatDate } from "@/lib/utils";
import type { MessageCampaign, NotificationChannel, Prisma } from "@/generated/prisma/client";

/**
 * Bulk messages to a filtered audience. A campaign is a draft until it is sent (now or at a scheduled time); the
 * worker then writes one Notification per recipient in batches (deduplicated, so a retried job never sends twice).
 * - service campaigns (outages, maintenance, changes) respect each subscriber's "service" preference;
 * - marketing campaigns (offers) go only to subscribers who agreed to receive them (no record = not agreed).
 * Variables: {{name}}, {{accountNumber}}, {{packageName}}, {{endDate}}, {{organization}}.
 */
export const CAMPAIGN_VARIABLES = ["name", "accountNumber", "packageName", "endDate", "organization"];
const BATCH = 500;

export const audienceInput = subscriberListQuery
  .pick({ subscription: true, service: true, connection: true, routerId: true, created: true, vip: true, risk: true })
  .extend({ packageId: z.uuid().optional() });

const campaignFields = z.object({
  name: z.string().trim().min(2).max(120),
  channel: z.enum(["SMS", "EMAIL"]),
  kind: z.enum(["service", "marketing"]),
  subject: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().min(5).max(5000),
  audience: audienceInput.default({}),
});

export const campaignInput = campaignFields.superRefine((v, ctx) => {
  if (v.channel === "SMS" && v.body.length > 480) ctx.addIssue({ code: "custom", path: ["body"], message: "SMS campaigns must be 480 characters or fewer." });
  if (v.channel === "EMAIL" && !v.subject) ctx.addIssue({ code: "custom", path: ["subject"], message: "Email campaigns need a subject." });
  const unknown = [...v.body.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)].map((m) => m[1]!).filter((k) => !CAMPAIGN_VARIABLES.includes(k));
  if (unknown.length) ctx.addIssue({ code: "custom", path: ["body"], message: `Unknown placeholder: {{${unknown[0]}}}. Use ${CAMPAIGN_VARIABLES.map((k) => `{{${k}}}`).join(", ")}.` });
});

export const sendCampaignInput = z.object({ scheduledAt: z.coerce.date().optional().nullable() });

const category = (kind: string) => (kind === "marketing" ? "marketing" : "service");

/** Branches the campaign may reach: the creator's scope when the campaign was saved (null = every branch). */
function branchScopeOf(ctx: StaffContext): string[] | null {
  return ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
}

async function recipientsWhere(ctx: ActorContext, c: { channel: NotificationChannel; audience: SubscriberFilters; branchScope: string[] | null }): Promise<Prisma.SubscriberWhereInput> {
  const base = await subscriberFilterWhere(ctx, c.audience);
  return { ...base, ...(c.branchScope ? { branchId: { in: c.branchScope } } : {}), ...(c.channel === "SMS" ? { phone: { not: "" } } : { email: { not: null } }) };
}

interface StoredAudience {
  filters: z.infer<typeof audienceInput>;
  branchScope: string[] | null;
}

const storedAudience = (raw: Prisma.JsonValue): StoredAudience => {
  const v = (raw ?? {}) as { filters?: unknown; branchScope?: string[] | null };
  return { filters: audienceInput.parse(v.filters ?? {}), branchScope: v.branchScope ?? null };
};

type Recipient = { id: string; displayName: string; accountNumber: string; phone: string; email: string | null; subscriptions: Array<{ packageName: string; currentPeriodEnd: Date | null }> };

const recipientSelect = {
  id: true,
  displayName: true,
  accountNumber: true,
  phone: true,
  email: true,
  subscriptions: { where: { status: { in: ["ACTIVE", "SUSPENDED", "PENDING", "EXPIRED"] } }, orderBy: { createdAt: "desc" }, take: 1, select: { packageName: true, currentPeriodEnd: true } },
} satisfies Prisma.SubscriberSelect;

function varsFor(r: Recipient, org: { name: string; timezone: string }) {
  const sub = r.subscriptions[0];
  return { name: r.displayName, accountNumber: r.accountNumber, packageName: sub?.packageName ?? "", endDate: sub?.currentPeriodEnd ? formatDate(sub.currentPeriodEnd, org.timezone) : "", organization: org.name };
}

/** How many subscribers match, how many would actually receive it (preferences), and a sample rendering. */
export async function previewCampaign(ctx: StaffContext, raw: z.input<typeof campaignInput>) {
  requirePermission(ctx, "notifications.write");
  const input = campaignInput.parse(raw);
  const where = await recipientsWhere(ctx, { channel: input.channel, audience: input.audience, branchScope: branchScopeOf(ctx) });
  const [ids, sample] = await Promise.all([db.subscriber.findMany({ where, select: { id: true } }), db.subscriber.findFirst({ where, orderBy: { createdAt: "desc" }, select: recipientSelect })]);
  const matched = ids.length;
  const prefs = matched ? await db.notificationPreference.findMany({ where: { organizationId: ctx.organizationId, channel: input.channel, category: category(input.kind), subscriberId: { in: ids.map((i) => i.id) } }, select: { enabled: true } }) : [];
  const willReceive = input.kind === "marketing" ? prefs.filter((p) => p.enabled).length : matched - prefs.filter((p) => !p.enabled).length;
  const org = { name: ctx.organization.name, timezone: ctx.organization.timezone };
  return {
    matched,
    willReceive,
    excluded: matched - willReceive,
    sample: sample ? { to: sample.displayName, subject: input.subject ? renderTemplate(input.subject, varsFor(sample, org)) : null, body: renderTemplate(input.body, varsFor(sample, org)) } : null,
  };
}

export async function createCampaign(ctx: StaffContext, raw: z.input<typeof campaignInput>) {
  requirePermission(ctx, "notifications.write");
  const input = campaignInput.parse(raw);
  const c = await db.messageCampaign.create({
    data: { organizationId: ctx.organizationId, name: input.name, channel: input.channel, kind: input.kind, subject: input.subject ?? null, body: input.body, audience: { filters: input.audience, branchScope: branchScopeOf(ctx) } as unknown as Prisma.InputJsonValue, createdById: ctx.userId },
  });
  await audit(ctx, { action: "campaign.create", entityType: "campaign", entityId: c.id, metadata: { name: c.name, channel: c.channel, kind: c.kind } });
  return c;
}

async function findCampaign(ctx: StaffContext, id: string) {
  const c = await db.messageCampaign.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!c) throw notFound("campaign");
  return c;
}

export async function updateCampaign(ctx: StaffContext, id: string, raw: z.input<typeof campaignInput>) {
  requirePermission(ctx, "notifications.write");
  const input = campaignInput.parse(raw);
  const c = await findCampaign(ctx, id);
  if (c.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only drafts can be edited.");
  const updated = await db.messageCampaign.update({ where: { id }, data: { name: input.name, channel: input.channel, kind: input.kind, subject: input.subject ?? null, body: input.body, audience: { filters: input.audience, branchScope: branchScopeOf(ctx) } as unknown as Prisma.InputJsonValue } });
  await audit(ctx, { action: "campaign.update", entityType: "campaign", entityId: id });
  return updated;
}

/** Send now, or at `scheduledAt` (future). The audience is resolved when sending starts, not now. */
export async function sendCampaign(ctx: StaffContext, id: string, raw: z.input<typeof sendCampaignInput>) {
  requirePermission(ctx, "notifications.write");
  const input = sendCampaignInput.parse(raw);
  const at = input.scheduledAt && input.scheduledAt.getTime() > Date.now() + 60_000 ? input.scheduledAt : null;
  if (input.scheduledAt && !at) throw new AppError("VALIDATION_ERROR", "Choose a time at least a minute from now, or send now.", { fields: [{ path: "scheduledAt", message: "Must be in the future" }] });
  const op = await db.$transaction(async (tx) => {
    const claimed = await tx.messageCampaign.updateMany({ where: { id, organizationId: ctx.organizationId, status: "DRAFT" }, data: { status: "SCHEDULED", scheduledAt: at ?? new Date() } });
    if (!claimed.count) {
      const exists = await tx.messageCampaign.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } });
      if (!exists) throw notFound("campaign");
      throw new AppError("INVALID_STATE", "This campaign has already been sent or scheduled.");
    }
    return enqueueOperation({ type: "campaigns.dispatch", organizationId: ctx.organizationId, payload: { campaignId: id }, dedupeKey: `campaign:${id}`, runAfter: at ?? undefined, maxAttempts: 5, correlationId: ctx.correlationId }, tx);
  });
  if (!at) await dispatchOperation(op);
  await audit(ctx, { action: at ? "campaign.schedule" : "campaign.send", entityType: "campaign", entityId: id, metadata: { scheduledAt: at?.toISOString() ?? null } });
  return findCampaign(ctx, id);
}

/** Stop a draft or scheduled campaign; a campaign being sent stops after the current batch. Queued messages still go. */
export async function cancelCampaign(ctx: StaffContext, id: string) {
  requirePermission(ctx, "notifications.write");
  const c = await findCampaign(ctx, id);
  if (!["DRAFT", "SCHEDULED", "SENDING"].includes(c.status)) throw new AppError("INVALID_STATE", "This campaign has finished.");
  await db.messageCampaign.updateMany({ where: { id, status: { in: ["DRAFT", "SCHEDULED", "SENDING"] } }, data: { status: "CANCELLED", completedAt: new Date() } });
  await audit(ctx, { action: "campaign.cancel", entityType: "campaign", entityId: id, metadata: { from: c.status } });
  return findCampaign(ctx, id);
}

async function queueCampaignMessageTx(tx: Tx, c: MessageCampaign, r: Recipient, org: { name: string; timezone: string }): Promise<"queued" | "skipped" | "exists"> {
  const dedupeKey = `campaign:${c.id}:${r.id}:${c.channel}`;
  if (await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } })) return "exists";
  const allowed = await preferenceAllows(tx, r.id, c.channel, category(c.kind));
  const vars = varsFor(r, org);
  const n = await tx.notification.create({
    data: {
      organizationId: c.organizationId,
      subscriberId: r.id,
      campaignId: c.id,
      channel: c.channel,
      templateKey: "campaign",
      category: category(c.kind),
      recipient: c.channel === "SMS" ? r.phone : r.email!,
      subject: c.subject ? renderTemplate(c.subject, vars) : null,
      body: renderTemplate(c.body, vars),
      status: allowed ? "QUEUED" : "SKIPPED",
      lastError: allowed ? null : c.kind === "marketing" ? "NO_MARKETING_CONSENT" : "OPTED_OUT",
      dedupeKey,
    },
  });
  if (!allowed) return "skipped";
  await enqueueOperation({ type: "notifications.send", organizationId: c.organizationId, payload: { notificationId: n.id }, dedupeKey: `notify:${n.id}`, maxAttempts: 5 }, tx);
  return "queued";
}

/**
 * Worker: resolve the audience and write messages in batches of 500, by subscriber id (resumable: already-written
 * recipients are skipped by their dedupe key). Stops early if the campaign is cancelled.
 */
export async function dispatchCampaign(campaignId: string) {
  const c = await db.messageCampaign.findUnique({ where: { id: campaignId } });
  if (!c || c.status === "CANCELLED" || c.status === "SENT" || c.status === "DRAFT") return { status: c?.status ?? "MISSING" };
  if (c.status === "SCHEDULED") await db.messageCampaign.update({ where: { id: c.id }, data: { status: "SENDING", startedAt: new Date() } });
  const org = await db.organization.findUniqueOrThrow({ where: { id: c.organizationId }, select: { name: true, timezone: true } });
  const saved = storedAudience(c.audience);
  const where = await recipientsWhere(systemContext(c.organizationId, "worker:campaigns", `campaign:${c.id}`), { channel: c.channel, audience: saved.filters, branchScope: saved.branchScope });
  let cursor: string | undefined;
  let recipients = 0;
  for (;;) {
    const fresh = await db.messageCampaign.findUnique({ where: { id: c.id }, select: { status: true } });
    if (fresh?.status === "CANCELLED") break;
    const page = await db.subscriber.findMany({ where, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), select: recipientSelect });
    if (!page.length) break;
    const counts = await db.$transaction(async (tx) => {
      let queued = 0;
      let skipped = 0;
      for (const r of page) {
        const result = await queueCampaignMessageTx(tx, c, r, org);
        if (result === "queued") queued++;
        else if (result === "skipped") skipped++;
      }
      return { queued, skipped };
    });
    recipients += page.length;
    await db.messageCampaign.update({ where: { id: c.id }, data: { queued: { increment: counts.queued }, skipped: { increment: counts.skipped } } });
    cursor = page[page.length - 1]!.id;
    if (page.length < BATCH) break;
  }
  const done = await db.messageCampaign.updateMany({ where: { id: c.id, status: "SENDING" }, data: { status: "SENT", completedAt: new Date(), recipients } });
  if (!done.count) await db.messageCampaign.update({ where: { id: c.id }, data: { recipients } });
  return { status: done.count ? "SENT" : "CANCELLED", recipients };
}

export async function listCampaigns(ctx: StaffContext) {
  requirePermission(ctx, "notifications.read");
  const rows = await db.messageCampaign.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 50 });
  const stats = rows.length ? await db.notification.groupBy({ by: ["campaignId", "status"], where: { organizationId: ctx.organizationId, campaignId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }) : [];
  return rows.map((r) => {
    const of = (s: string) => stats.find((x) => x.campaignId === r.id && x.status === s)?._count._all ?? 0;
    return { ...r, delivery: { queued: of("QUEUED"), sent: of("SENT"), failed: of("FAILED"), skipped: of("SKIPPED") } };
  });
}

export async function getCampaign(ctx: StaffContext, id: string) {
  requirePermission(ctx, "notifications.read");
  const c = await findCampaign(ctx, id);
  return { ...c, audience: storedAudience(c.audience) };
}

/** Guard for the worker handler: the payload must name a campaign. */
export function campaignIdOf(payload: unknown): string {
  const id = (payload as { campaignId?: string } | null)?.campaignId;
  if (!id) throw new PermanentError("campaignId missing", "BAD_PAYLOAD");
  return id;
}
