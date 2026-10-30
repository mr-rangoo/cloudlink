import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { listWhere, requirePermission, resolveBranchForCreate, tenantWhere, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { normalizeEmail, normalizePhone } from "@/server/domain/contact";
import { actorUserId, lockRow, searchTerm } from "@/server/services/common";
import { createSubscriberTx, findContactDuplicates } from "@/server/services/subscribers";
import type { Prisma } from "@/generated/prisma/client";

export const LEAD_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "SITE_SURVEY", "PROPOSAL", "WON", "LOST"] as const;
export const LEAD_SOURCES = ["WALK_IN", "REFERRAL", "WEBSITE", "SOCIAL_MEDIA", "PHONE_CALL", "FIELD_AGENT", "OTHER"] as const;

const phone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: "custom", message: "Enter a valid phone number, e.g. 0712 345 678." });
    return n ?? "";
  });

const optEmail = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v) return null;
    if (!z.email().safeParse(v).success) ctx.addIssue({ code: "custom", message: "Enter a valid email address." });
    return v;
  });

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === undefined ? undefined : v ? v : null));

export const leadInput = z.object({
  name: z.string().trim().min(2).max(120),
  phone,
  email: optEmail,
  source: z.enum(LEAD_SOURCES).default("OTHER"),
  location: optText(200),
  notes: optText(2000),
  interestedPackageId: z.uuid().optional().nullable(),
  ownerId: z.uuid().optional().nullable(),
  branchId: z.uuid().optional().nullable(),
});

export const leadUpdate = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: phone.optional(),
  email: optEmail,
  source: z.enum(LEAD_SOURCES).optional(),
  stage: z.enum(LEAD_STAGES).exclude(["WON"]).optional(),
  location: optText(200),
  notes: optText(2000),
  lostReason: optText(500),
  interestedPackageId: z.uuid().optional().nullable(),
  ownerId: z.uuid().optional().nullable(),
});

export const leadActivityInput = z.object({
  type: z.enum(["note", "call", "meeting", "site_survey"]),
  message: z.string().trim().min(1).max(2000),
});

export const leadConvertInput = z.object({
  type: z.enum(["INDIVIDUAL", "BUSINESS"]).default("INDIVIDUAL"),
  firstName: optText(80),
  lastName: optText(80),
  companyName: optText(160),
  idNumber: optText(40),
  address: z.object({ line1: z.string().trim().min(2).max(200), area: optText(100), town: optText(100), county: optText(100) }).optional().nullable(),
  packageId: z.uuid().optional().nullable(),
  activateSubscription: z.boolean().default(true),
  allowDuplicateContact: z.boolean().default(false),
});

export const leadListQuery = z.object({
  q: z.string().optional(),
  stage: z.enum([...LEAD_STAGES, "OPEN", "ALL"]).default("OPEN"),
  source: z.enum(LEAD_SOURCES).optional(),
  owner: z.enum(["me", "unassigned"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const leadSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  source: true,
  stage: true,
  ownerId: true,
  branchId: true,
  interestedPackageId: true,
  location: true,
  notes: true,
  lostReason: true,
  convertedSubscriberId: true,
  convertedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

async function assertOwner(ctx: ActorContext, ownerId: string | null | undefined) {
  if (!ownerId) return;
  const m = await db.membership.findFirst({ where: { organizationId: ctx.organizationId, userId: ownerId, status: "ACTIVE" }, select: { id: true } });
  if (!m) throw new AppError("VALIDATION_ERROR", "The selected owner is not an active staff member of this organization.", { fields: [{ path: "ownerId", message: "Invalid owner" }] });
}

async function assertPackage(ctx: ActorContext, packageId: string | null | undefined) {
  if (!packageId) return;
  const p = await db.package.findFirst({ where: { id: packageId, organizationId: ctx.organizationId }, select: { id: true } });
  if (!p) throw new AppError("VALIDATION_ERROR", "The selected package does not exist.", { fields: [{ path: "interestedPackageId", message: "Invalid package" }] });
}

export async function createLead(ctx: ActorContext, input: z.infer<typeof leadInput>) {
  requirePermission(ctx, "leads.write");
  await assertOwner(ctx, input.ownerId);
  await assertPackage(ctx, input.interestedPackageId);
  const branchId = await resolveBranchForCreate(ctx, input.branchId);
  const ownerId = input.ownerId ?? (ctx.kind === "staff" ? ctx.userId : null);
  const existingSubscriber = await findContactDuplicates(db, ctx.organizationId, input.phone, input.email);

  const lead = await db.$transaction(async (tx) => {
    const l = await tx.lead.create({
      data: { ...input, organizationId: ctx.organizationId, branchId, ownerId, emailNormalized: normalizeEmail(input.email) },
      select: leadSelect,
    });
    await tx.leadActivity.create({
      data: {
        organizationId: ctx.organizationId,
        leadId: l.id,
        actorUserId: actorUserId(ctx),
        type: "created",
        message: `Lead created from ${input.source.toLowerCase().replace("_", " ")}`,
        metadata: existingSubscriber.length ? { matchesExistingSubscriber: existingSubscriber.map((s) => s.accountNumber) } : undefined,
      },
    });
    return l;
  });
  await audit(ctx, { action: "lead.create", entityType: "lead", entityId: lead.id });
  return { lead, existingSubscribers: existingSubscriber };
}

export async function updateLead(ctx: ActorContext, id: string, input: z.infer<typeof leadUpdate>) {
  requirePermission(ctx, "leads.write");
  const before = await db.lead.findFirst({ where: { id, ...tenantWhere(ctx) }, select: leadSelect });
  if (!before) throw notFound("lead");
  if (before.stage === "WON") throw new AppError("INVALID_STATE", "Converted leads are read-only; edit the subscriber instead.");
  if (input.stage === "LOST" && !input.lostReason && !before.lostReason) {
    throw new AppError("VALIDATION_ERROR", "Give a reason when marking a lead as lost.", { fields: [{ path: "lostReason", message: "Required when stage is LOST" }] });
  }
  await assertOwner(ctx, input.ownerId);
  await assertPackage(ctx, input.interestedPackageId);

  const lead = await db.$transaction(async (tx) => {
    const l = await tx.lead.update({
      where: { id },
      data: { ...input, ...(input.email !== undefined ? { emailNormalized: normalizeEmail(input.email) } : {}) },
      select: leadSelect,
    });
    const events: Prisma.LeadActivityCreateManyInput[] = [];
    if (input.stage && input.stage !== before.stage) {
      events.push({ organizationId: ctx.organizationId, leadId: id, actorUserId: actorUserId(ctx), type: "stage_changed", message: `Stage changed from ${before.stage} to ${input.stage}${input.lostReason ? `: ${input.lostReason}` : ""}`, metadata: { from: before.stage, to: input.stage } });
    }
    if (input.ownerId !== undefined && input.ownerId !== before.ownerId) {
      events.push({ organizationId: ctx.organizationId, leadId: id, actorUserId: actorUserId(ctx), type: "assigned", message: input.ownerId ? "Lead reassigned" : "Lead unassigned", metadata: { from: before.ownerId, to: input.ownerId } });
    }
    const other = Object.keys(input).filter((k) => !["stage", "ownerId"].includes(k) && String((before as Record<string, unknown>)[k] ?? "") !== String((input as Record<string, unknown>)[k] ?? ""));
    if (other.length) events.push({ organizationId: ctx.organizationId, leadId: id, actorUserId: actorUserId(ctx), type: "updated", message: `Updated ${other.join(", ")}`, metadata: { changed: other } });
    if (events.length) await tx.leadActivity.createMany({ data: events });
    return l;
  });
  await audit(ctx, { action: "lead.update", entityType: "lead", entityId: id, metadata: { stage: input.stage } });
  return lead;
}

export async function addLeadActivity(ctx: ActorContext, id: string, input: z.infer<typeof leadActivityInput>) {
  requirePermission(ctx, "leads.write");
  const lead = await db.lead.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true, stage: true } });
  if (!lead) throw notFound("lead");
  return db.$transaction(async (tx) => {
    const act = await tx.leadActivity.create({
      data: { organizationId: ctx.organizationId, leadId: id, actorUserId: actorUserId(ctx), type: input.type, message: input.message },
      select: { id: true, type: true, message: true, createdAt: true },
    });
    if (lead.stage === "NEW" && (input.type === "call" || input.type === "meeting")) {
      await tx.lead.update({ where: { id }, data: { stage: "CONTACTED" } });
      await tx.leadActivity.create({ data: { organizationId: ctx.organizationId, leadId: id, actorUserId: actorUserId(ctx), type: "stage_changed", message: "Stage changed from NEW to CONTACTED", metadata: { from: "NEW", to: "CONTACTED", automatic: true } } });
    }
    return act;
  });
}

/**
 * Convert a lead into a subscriber (and optionally a subscription) in one transaction.
 * The lead row is locked so concurrent conversions cannot create two subscribers; the lead and its full
 * activity history are preserved and linked to the new subscriber.
 */
export async function convertLead(ctx: ActorContext, id: string, input: z.infer<typeof leadConvertInput>) {
  requirePermission(ctx, "leads.write", "subscribers.write");
  const visible = await db.lead.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true } });
  if (!visible) throw notFound("lead");

  const result = await db.$transaction(async (tx) => {
    await lockRow(tx, "Lead", id);
    const lead = await tx.lead.findUniqueOrThrow({ where: { id } });
    if (lead.convertedSubscriberId) throw new AppError("CONFLICT", "This lead has already been converted.", { details: { subscriberId: lead.convertedSubscriberId } });
    if (lead.stage === "LOST") throw new AppError("INVALID_STATE", "Reopen this lost lead before converting it.");

    const [first, ...rest] = lead.name.split(/\s+/);
    const { subscriber, subscription } = await createSubscriberTx(
      tx,
      ctx,
      {
        type: input.type,
        firstName: input.firstName ?? (input.type === "INDIVIDUAL" ? (first ?? lead.name) : null),
        lastName: input.lastName ?? (input.type === "INDIVIDUAL" && rest.length ? rest.join(" ") : null),
        companyName: input.companyName ?? (input.type === "BUSINESS" ? lead.name : null),
        email: lead.email,
        phone: lead.phone,
        altPhone: null,
        idNumber: input.idNumber,
        notes: lead.notes,
        branchId: lead.branchId,
        address: input.address ?? (lead.location ? { line1: lead.location, area: null, town: null, county: null } : null),
        packageId: input.packageId ?? lead.interestedPackageId,
        activateSubscription: input.activateSubscription,
        allowDuplicateContact: input.allowDuplicateContact,
      },
      { source: "lead conversion", welcome: true },
    );
    await tx.lead.update({ where: { id }, data: { stage: "WON", convertedSubscriberId: subscriber.id, convertedAt: new Date() } });
    await tx.leadActivity.create({
      data: { organizationId: ctx.organizationId, leadId: id, actorUserId: actorUserId(ctx), type: "converted", message: `Converted to subscriber ${subscriber.accountNumber}`, metadata: { subscriberId: subscriber.id, subscriptionId: subscription?.id } },
    });
    await tx.subscriberActivity.create({
      data: { organizationId: ctx.organizationId, subscriberId: subscriber.id, actorUserId: actorUserId(ctx), type: "lead.converted", message: `Converted from lead "${lead.name}" (source: ${lead.source})`, metadata: { leadId: id } },
    });
    return { subscriber, subscription };
  });
  await audit(ctx, { action: "lead.convert", entityType: "lead", entityId: id, metadata: { subscriberId: result.subscriber.id, subscriptionId: result.subscription?.id } });
  return result;
}

export async function listLeads(ctx: ActorContext, query: z.infer<typeof leadListQuery>) {
  requirePermission(ctx, "leads.read");
  const q = searchTerm(query.q);
  const where: Prisma.LeadWhereInput = {
    ...listWhere(ctx),
    ...(query.stage === "OPEN" ? { stage: { notIn: ["WON", "LOST"] } } : query.stage !== "ALL" ? { stage: query.stage } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.owner === "me" && ctx.kind === "staff" ? { ownerId: ctx.userId } : query.owner === "unassigned" ? { ownerId: null } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: normalizePhone(q) ?? q } }, { emailNormalized: { contains: q.toLowerCase() } }, { location: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total, stageCounts] = await Promise.all([
    db.lead.findMany({ where, select: { ...leadSelect, interestedPackage: { select: { name: true } } }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.lead.count({ where }),
    db.lead.groupBy({ by: ["stage"], where: listWhere(ctx), _count: { _all: true } }),
  ]);
  const owners = await ownerNames([...new Set(rows.map((r) => r.ownerId).filter((v): v is string => Boolean(v)))]);
  return {
    rows: rows.map((r) => ({ ...r, ownerName: r.ownerId ? (owners.get(r.ownerId) ?? null) : null })),
    total,
    stageCounts: Object.fromEntries(stageCounts.map((s) => [s.stage, s._count._all])) as Partial<Record<(typeof LEAD_STAGES)[number], number>>,
  };
}

async function ownerNames(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function getLead(ctx: ActorContext, id: string) {
  requirePermission(ctx, "leads.read");
  const lead = await db.lead.findFirst({
    where: { id, ...tenantWhere(ctx) },
    select: {
      ...leadSelect,
      interestedPackage: { select: { id: true, name: true } },
      convertedSubscriber: { select: { id: true, accountNumber: true, displayName: true } },
      activities: { orderBy: { createdAt: "desc" }, take: 100, select: { id: true, type: true, message: true, actorUserId: true, createdAt: true } },
    },
  });
  if (!lead) throw notFound("lead");
  const names = await ownerNames([...new Set([lead.ownerId, ...lead.activities.map((a) => a.actorUserId)].filter((v): v is string => Boolean(v)))]);
  return {
    ...lead,
    ownerName: lead.ownerId ? (names.get(lead.ownerId) ?? null) : null,
    activities: lead.activities.map((a) => ({ ...a, actorName: a.actorUserId ? (names.get(a.actorUserId) ?? "Staff") : "System" })),
  };
}

export async function listAssignableStaff(ctx: ActorContext) {
  const members = await db.membership.findMany({
    where: { organizationId: ctx.organizationId, status: "ACTIVE", user: { status: "ACTIVE" } },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return members.map((m) => m.user);
}
