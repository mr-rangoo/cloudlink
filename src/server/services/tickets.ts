import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { listWhere, requirePermission, tenantWhere, type CustomerContext, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { safeFileName, validateUpload } from "@/server/domain/uploads";
import { storage } from "@/server/integrations/storage";
import { nextCounter, searchTerm } from "@/server/services/common";
import { queueSubscriberNotificationTx } from "@/server/services/notifications";
import type { Prisma, TicketStatus } from "@/generated/prisma/client";

const CATEGORIES = ["CONNECTIVITY", "BILLING", "INSTALLATION", "EQUIPMENT", "ACCOUNT", "OTHER"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
const STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED"] as const;

export const staffTicketInput = z.object({
  subscriberId: z.uuid().optional().nullable(),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(3).max(5000),
  category: z.enum(CATEGORIES).default("OTHER"),
  priority: z.enum(PRIORITIES).default("NORMAL"),
  assigneeId: z.uuid().optional().nullable(),
  channel: z.enum(["staff", "phone", "walk_in", "email"]).default("phone"),
});

export const customerTicketInput = z.object({
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(3).max(5000),
  category: z.enum(CATEGORIES).default("OTHER"),
});

export const ticketUpdateInput = z
  .object({
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: z.uuid().nullable().optional(),
    resolution: z.string().trim().min(3).max(2000).optional(),
  })
  .refine((v) => v.status !== "RESOLVED" || v.resolution, { path: ["resolution"], message: "Describe the resolution." });

export const commentInput = z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) });
export const customerCommentInput = z.object({ body: z.string().trim().min(1).max(5000) });

export const ticketListQuery = z.object({
  q: z.string().optional(),
  status: z.enum([...STATUSES, "ACTIVE", "ALL"]).default("ACTIVE"),
  priority: z.enum(PRIORITIES).optional(),
  assignee: z.enum(["me", "unassigned"]).optional(),
  subscriberId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const ACTIVE_STATUSES: TicketStatus[] = ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER"];

async function ticketNumber(tx: Tx, organizationId: string) {
  return `TKT-${String(await nextCounter(tx, organizationId, "ticket")).padStart(6, "0")}`;
}

async function assertAssignee(organizationId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const m = await db.membership.findFirst({ where: { organizationId, userId: assigneeId, status: "ACTIVE" } });
  if (!m) throw new AppError("VALIDATION_ERROR", "The assignee is not an active staff member.", { fields: [{ path: "assigneeId", message: "Invalid assignee" }] });
}

// ───────── Staff ─────────

export async function createTicket(ctx: StaffContext, input: z.infer<typeof staffTicketInput>) {
  requirePermission(ctx, "support.write");
  await assertAssignee(ctx.organizationId, input.assigneeId);
  let branchId: string | null = ctx.activeBranchId;
  if (input.subscriberId) {
    const sub = await db.subscriber.findFirst({ where: { id: input.subscriberId, ...tenantWhere(ctx) }, select: { branchId: true } });
    if (!sub) throw notFound("subscriber");
    branchId = sub.branchId;
  }
  const ticket = await db.$transaction(async (tx) => {
    const t = await tx.supportTicket.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        subscriberId: input.subscriberId ?? null,
        ticketNumber: await ticketNumber(tx, ctx.organizationId),
        subject: input.subject,
        description: input.description,
        category: input.category,
        priority: input.priority,
        assigneeId: input.assigneeId ?? null,
        channel: input.channel,
        createdByUserId: ctx.userId,
      },
    });
    await tx.ticketEvent.create({ data: { organizationId: ctx.organizationId, ticketId: t.id, actorUserId: ctx.userId, actorType: "user", type: "created", toValue: "OPEN" } });
    if (input.subscriberId) {
      await tx.subscriberActivity.create({ data: { organizationId: ctx.organizationId, subscriberId: input.subscriberId, actorUserId: ctx.userId, type: "ticket.created", message: `Ticket ${t.ticketNumber} opened: ${t.subject}` } });
    }
    return t;
  });
  await audit(ctx, { action: "ticket.create", entityType: "ticket", entityId: ticket.id, metadata: { number: ticket.ticketNumber } });
  return ticket;
}

export async function listTickets(ctx: StaffContext, query: z.infer<typeof ticketListQuery>) {
  requirePermission(ctx, "support.read");
  const q = searchTerm(query.q);
  const where: Prisma.SupportTicketWhereInput = {
    ...(ctx.branchIds || ctx.activeBranchId ? listWhere(ctx) : { organizationId: ctx.organizationId }),
    ...(query.status === "ACTIVE" ? { status: { in: ACTIVE_STATUSES } } : query.status !== "ALL" ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.assignee === "me" ? { assigneeId: ctx.userId } : query.assignee === "unassigned" ? { assigneeId: null } : {}),
    ...(query.subscriberId ? { subscriberId: query.subscriberId } : {}),
    ...(q ? { OR: [{ ticketNumber: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total, counts] = await Promise.all([
    db.supportTicket.findMany({ where, orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.supportTicket.count({ where }),
    db.supportTicket.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId }, _count: { _all: true } }),
  ]);
  const [subs, users] = await Promise.all([
    db.subscriber.findMany({ where: { id: { in: rows.map((r) => r.subscriberId).filter((v): v is string => Boolean(v)) } }, select: { id: true, displayName: true, accountNumber: true } }),
    db.user.findMany({ where: { id: { in: rows.map((r) => r.assigneeId).filter((v): v is string => Boolean(v)) } }, select: { id: true, name: true } }),
  ]);
  const subById = new Map(subs.map((s) => [s.id, s]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  return {
    rows: rows.map((r) => ({ ...r, subscriber: r.subscriberId ? (subById.get(r.subscriberId) ?? null) : null, assigneeName: r.assigneeId ? (userById.get(r.assigneeId) ?? null) : null })),
    total,
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<TicketStatus, number>>,
  };
}

async function loadStaffTicket(ctx: StaffContext, id: string) {
  const t = await db.supportTicket.findFirst({ where: { id, organizationId: ctx.organizationId, ...(ctx.branchIds ? { OR: [{ branchId: { in: ctx.branchIds } }, { branchId: null, subscriberId: null }] } : {}) } });
  if (!t) throw notFound("ticket");
  return t;
}

export async function getTicket(ctx: StaffContext, id: string) {
  requirePermission(ctx, "support.read");
  const t = await loadStaffTicket(ctx, id);
  const [comments, events, attachments, subscriber] = await Promise.all([
    db.ticketComment.findMany({ where: { ticketId: id }, orderBy: { createdAt: "asc" } }),
    db.ticketEvent.findMany({ where: { ticketId: id }, orderBy: { createdAt: "asc" } }),
    db.ticketAttachment.findMany({ where: { ticketId: id }, orderBy: { createdAt: "asc" }, select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, commentId: true, uploadedByCustomerId: true } }),
    t.subscriberId ? db.subscriber.findUnique({ where: { id: t.subscriberId }, select: { id: true, displayName: true, accountNumber: true, phone: true } }) : null,
  ]);
  const userIds = [...new Set([t.assigneeId, t.createdByUserId, ...comments.map((c) => c.authorUserId), ...events.map((e) => e.actorUserId)].filter((v): v is string => Boolean(v)))];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    ...t,
    subscriber,
    assigneeName: t.assigneeId ? (names.get(t.assigneeId) ?? null) : null,
    comments: comments.map((c) => ({ ...c, authorName: c.authorUserId ? (names.get(c.authorUserId) ?? "Staff") : subscriber?.displayName ?? "Customer", fromCustomer: Boolean(c.authorCustomerId) })),
    events: events.map((e) => ({ ...e, actorName: e.actorUserId ? (names.get(e.actorUserId) ?? "Staff") : e.actorType === "customer" ? "Customer" : "System" })),
    attachments,
  };
}

export async function addStaffComment(ctx: StaffContext, id: string, input: z.infer<typeof commentInput>) {
  requirePermission(ctx, "support.write");
  const t = await loadStaffTicket(ctx, id);
  if (t.status === "CLOSED") throw new AppError("INVALID_STATE", "Closed tickets cannot receive replies.");
  const comment = await db.$transaction(async (tx) => {
    const c = await tx.ticketComment.create({ data: { organizationId: ctx.organizationId, ticketId: id, authorUserId: ctx.userId, body: input.body, internal: input.internal } });
    if (!input.internal) {
      const data: Prisma.SupportTicketUpdateInput = {};
      if (!t.firstResponseAt) data.firstResponseAt = new Date();
      if (t.status === "OPEN") {
        data.status = "IN_PROGRESS";
        await tx.ticketEvent.create({ data: { organizationId: ctx.organizationId, ticketId: id, actorUserId: ctx.userId, actorType: "user", type: "status_changed", fromValue: "OPEN", toValue: "IN_PROGRESS" } });
      }
      if (Object.keys(data).length) await tx.supportTicket.update({ where: { id }, data });
      if (t.subscriberId) {
        await queueSubscriberNotificationTx(tx, ctx.organizationId, {
          subscriberId: t.subscriberId,
          key: "ticket.reply",
          vars: { ticketNumber: t.ticketNumber, subject: t.subject, message: input.body.slice(0, 1000) },
          dedupeBase: `ticket.reply:${c.id}`,
        });
      }
    }
    return c;
  });
  await audit(ctx, { action: input.internal ? "ticket.internal_note" : "ticket.reply", entityType: "ticket", entityId: id });
  return comment;
}

export async function updateTicket(ctx: StaffContext, id: string, input: z.infer<typeof ticketUpdateInput>) {
  requirePermission(ctx, "support.write");
  if (input.status === "RESOLVED" && !input.resolution) {
    throw new AppError("VALIDATION_ERROR", "Describe the resolution.", { fields: [{ path: "resolution", message: "Required when resolving" }] });
  }
  const t = await loadStaffTicket(ctx, id);
  await assertAssignee(ctx.organizationId, input.assigneeId);
  const updated = await db.$transaction(async (tx) => {
    const data: Prisma.SupportTicketUncheckedUpdateInput = {};
    const events: Array<{ type: string; fromValue: string | null; toValue: string | null }> = [];
    if (input.status && input.status !== t.status) {
      data.status = input.status;
      if (input.status === "RESOLVED") {
        data.resolvedAt = new Date();
        data.resolution = input.resolution;
      }
      if (input.status === "CLOSED") data.closedAt = new Date();
      if ((t.status === "RESOLVED" || t.status === "CLOSED") && ACTIVE_STATUSES.includes(input.status)) {
        data.resolvedAt = null;
        data.closedAt = null;
      }
      events.push({ type: input.status === "RESOLVED" ? "resolved" : "status_changed", fromValue: t.status, toValue: input.status });
    }
    if (input.priority && input.priority !== t.priority) {
      data.priority = input.priority;
      events.push({ type: "priority_changed", fromValue: t.priority, toValue: input.priority });
    }
    if (input.assigneeId !== undefined && input.assigneeId !== t.assigneeId) {
      data.assigneeId = input.assigneeId;
      events.push({ type: "assigned", fromValue: t.assigneeId, toValue: input.assigneeId });
    }
    if (!events.length) return t;
    const u = await tx.supportTicket.update({ where: { id }, data });
    await tx.ticketEvent.createMany({ data: events.map((e) => ({ ...e, organizationId: ctx.organizationId, ticketId: id, actorUserId: ctx.userId, actorType: "user" })) });
    if (input.status === "RESOLVED" && t.subscriberId) {
      await queueSubscriberNotificationTx(tx, ctx.organizationId, {
        subscriberId: t.subscriberId,
        key: "ticket.resolved",
        vars: { ticketNumber: t.ticketNumber, subject: t.subject, resolution: input.resolution ?? "" },
        dedupeBase: `ticket.resolved:${id}:${Date.now()}`,
      });
    }
    return u;
  });
  await audit(ctx, { action: "ticket.update", entityType: "ticket", entityId: id, metadata: input });
  return updated;
}

// ───────── Customer portal ─────────

export async function createCustomerTicket(ctx: CustomerContext, input: z.infer<typeof customerTicketInput>) {
  const sub = await db.subscriber.findUniqueOrThrow({ where: { id: ctx.subscriberId }, select: { branchId: true } });
  const open = await db.supportTicket.count({ where: { organizationId: ctx.organizationId, subscriberId: ctx.subscriberId, status: { in: ACTIVE_STATUSES } } });
  if (open >= 10) throw new AppError("INVALID_STATE", "You have too many open tickets. Please reply to an existing ticket.");
  const t = await db.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: sub.branchId,
        subscriberId: ctx.subscriberId,
        ticketNumber: await ticketNumber(tx, ctx.organizationId),
        subject: input.subject,
        description: input.description,
        category: input.category,
        priority: input.category === "CONNECTIVITY" ? "HIGH" : "NORMAL",
        channel: "portal",
        createdByCustomerId: ctx.customerAccountId,
      },
    });
    await tx.ticketEvent.create({ data: { organizationId: ctx.organizationId, ticketId: ticket.id, actorType: "customer", type: "created", toValue: "OPEN" } });
    await tx.subscriberActivity.create({ data: { organizationId: ctx.organizationId, subscriberId: ctx.subscriberId, type: "ticket.created", message: `Ticket ${ticket.ticketNumber} opened from the portal: ${ticket.subject}` } });
    return ticket;
  });
  await audit(ctx, { action: "portal.ticket_create", entityType: "ticket", entityId: t.id });
  return t;
}

async function loadCustomerTicket(ctx: CustomerContext, id: string) {
  const t = await db.supportTicket.findFirst({ where: { id, organizationId: ctx.organizationId, subscriberId: ctx.subscriberId } });
  if (!t) throw notFound("ticket"); // includes tickets of other customers: never reveal existence
  return t;
}

export async function listCustomerTickets(ctx: CustomerContext) {
  return db.supportTicket.findMany({
    where: { organizationId: ctx.organizationId, subscriberId: ctx.subscriberId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, ticketNumber: true, subject: true, status: true, category: true, createdAt: true, updatedAt: true, resolvedAt: true },
  });
}

export async function getCustomerTicket(ctx: CustomerContext, id: string) {
  const t = await loadCustomerTicket(ctx, id);
  const [comments, attachments] = await Promise.all([
    db.ticketComment.findMany({ where: { ticketId: id, internal: false }, orderBy: { createdAt: "asc" }, select: { id: true, body: true, createdAt: true, authorCustomerId: true } }),
    db.ticketAttachment.findMany({ where: { ticketId: id }, orderBy: { createdAt: "asc" }, select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true } }),
  ]);
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    description: t.description,
    category: t.category,
    status: t.status,
    resolution: t.resolution,
    createdAt: t.createdAt,
    resolvedAt: t.resolvedAt,
    comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, fromCustomer: Boolean(c.authorCustomerId) })),
    attachments,
  };
}

export async function addCustomerComment(ctx: CustomerContext, id: string, body: string) {
  const t = await loadCustomerTicket(ctx, id);
  if (t.status === "CLOSED") throw new AppError("INVALID_STATE", "This ticket is closed. Please open a new ticket.");
  const c = await db.$transaction(async (tx) => {
    const comment = await tx.ticketComment.create({ data: { organizationId: ctx.organizationId, ticketId: id, authorCustomerId: ctx.customerAccountId, body } });
    if (t.status === "WAITING_ON_CUSTOMER" || t.status === "RESOLVED") {
      await tx.supportTicket.update({ where: { id }, data: { status: "OPEN", resolvedAt: null } });
      await tx.ticketEvent.create({ data: { organizationId: ctx.organizationId, ticketId: id, actorType: "customer", type: t.status === "RESOLVED" ? "reopened" : "status_changed", fromValue: t.status, toValue: "OPEN" } });
    }
    return comment;
  });
  await audit(ctx, { action: "portal.ticket_reply", entityType: "ticket", entityId: id });
  return { id: c.id };
}

// ───────── Attachments (staff and customer) ─────────

export async function addAttachment(ctx: StaffContext | CustomerContext, ticketId: string, file: { name: string; data: Buffer }) {
  if (ctx.kind === "staff") {
    requirePermission(ctx, "support.write");
    await loadStaffTicket(ctx, ticketId);
  } else {
    await loadCustomerTicket(ctx, ticketId);
  }
  const check = validateUpload(file.data, file.name);
  if (!check.ok) throw new AppError("VALIDATION_ERROR", check.error ?? "Invalid file.");
  const count = await db.ticketAttachment.count({ where: { ticketId } });
  if (count >= 20) throw new AppError("INVALID_STATE", "This ticket already has the maximum number of attachments.");
  const key = `tickets/${ctx.organizationId}/${ticketId}/${randomUUID()}.${check.extension}`;
  await storage().put(key, file.data, check.contentType!);
  const row = await db.ticketAttachment.create({
    data: {
      organizationId: ctx.organizationId,
      ticketId,
      fileName: safeFileName(file.name),
      contentType: check.contentType!,
      sizeBytes: file.data.length,
      storageKey: key,
      sha256: createHash("sha256").update(file.data).digest("hex"),
      uploadedByUserId: ctx.kind === "staff" ? ctx.userId : null,
      uploadedByCustomerId: ctx.kind === "customer" ? ctx.customerAccountId : null,
    },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
  });
  await audit(ctx, { action: "ticket.attachment_add", entityType: "ticket", entityId: ticketId, metadata: { attachmentId: row.id, size: row.sizeBytes, type: row.contentType } });
  return row;
}

export async function readAttachment(ctx: StaffContext | CustomerContext, attachmentId: string) {
  const a = await db.ticketAttachment.findFirst({ where: { id: attachmentId, organizationId: ctx.organizationId } });
  if (!a) throw notFound("attachment");
  if (ctx.kind === "staff") {
    requirePermission(ctx, "support.read");
    await loadStaffTicket(ctx, a.ticketId);
  } else {
    await loadCustomerTicket(ctx, a.ticketId);
  }
  return { data: await storage().get(a.storageKey), fileName: a.fileName, contentType: a.contentType };
}

export function attachmentResponse(file: { data: Buffer; fileName: string; contentType: string }) {
  return new Response(new Uint8Array(file.data), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
