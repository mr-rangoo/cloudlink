import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { listWhere, requirePermission, tenantWhere, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { D, moneyInput, percentInput, positiveMoneyInput } from "@/server/domain/money";
import { computeLine, computeTotals, InvoiceMathError, splitCreditNote } from "@/server/domain/invoice-math";
import { periodAt } from "@/server/domain/billing-period";
import { addLocalDays, endOfLocalDay, localDateKey } from "@/server/domain/time";
import { actorUserId, lockRow, nextCounter, searchTerm } from "@/server/services/common";
import { postLedger } from "@/server/services/ledger";
import { adjustInvoiceSettlementTx, autoAllocateForSubscriberTx, lockInvoice } from "@/server/services/settlement";
import { queueSubscriberNotificationTx } from "@/server/services/notifications";
import { formatDate, formatMoney } from "@/lib/utils";
import type { Invoice, Prisma, Subscription } from "@/generated/prisma/client";

const dec = (v: { toString(): string }) => new D(v.toString());

export const lineInput = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d{1,9}(\.\d{1,3})?$/.test(v) && new D(v).gt(0), { message: "Quantity must be a positive number (up to 3 decimals)." }),
  unitPrice: moneyInput,
  discount: moneyInput.optional(),
  taxRate: percentInput.optional(),
});

export const invoiceCreateInput = z.object({
  subscriberId: z.uuid(),
  lines: z.array(lineInput).min(1).max(50),
  dueAt: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
  issue: z.boolean().default(true),
});

export const invoiceListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["DRAFT", "OPEN", "PARTIALLY_PAID", "PAID", "VOID", "OVERDUE", "UNPAID", "ALL"]).default("ALL"),
  subscriberId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const voidInput = z.object({ reason: z.string().trim().min(3).max(500) });
export const creditNoteInput = z.object({ amount: positiveMoneyInput, reason: z.string().trim().min(3).max(500) });

export async function getBillingSettings(client: Tx | typeof db, organizationId: string) {
  return client.billingSettings.upsert({ where: { organizationId }, update: {}, create: { organizationId } });
}

function mathError(err: unknown): never {
  if (err instanceof InvoiceMathError) throw new AppError("VALIDATION_ERROR", err.message);
  throw err;
}

interface CreateArgs {
  subscriberId: string;
  subscriptionId?: string | null;
  lines: Array<z.infer<typeof lineInput> & { packageId?: string | null; periodStart?: Date | null; periodEnd?: Date | null }>;
  dueAt?: Date | null;
  notes?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  generationKey?: string | null;
  source: "manual" | "recurring" | "activation" | "renewal";
  issue: boolean;
}

/**
 * Create an invoice (optionally issuing it). With a generationKey the call is idempotent: if an invoice with the
 * same key exists it is returned unchanged ({ created: false }). Lines are always written while the invoice is a
 * DRAFT; issuing then freezes them (database trigger).
 */
export async function createInvoiceTx(tx: Tx, ctx: ActorContext, args: CreateArgs): Promise<{ invoice: Invoice; created: boolean }> {
  if (args.generationKey) {
    const existing = await tx.invoice.findUnique({ where: { organizationId_generationKey: { organizationId: ctx.organizationId, generationKey: args.generationKey } } });
    if (existing) return { invoice: existing, created: false };
  }
  const subscriber = await tx.subscriber.findFirst({ where: { id: args.subscriberId, ...tenantWhere(ctx) }, select: { id: true, branchId: true, status: true } });
  if (!subscriber) throw notFound("subscriber");
  if (subscriber.status === "ARCHIVED") throw new AppError("INVALID_STATE", "Archived subscribers cannot be invoiced.");
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });

  let computed;
  try {
    computed = args.lines.map((l) => ({ ...computeLine({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate }), src: l }));
  } catch (err) {
    mathError(err);
  }
  const totals = computeTotals(computed);

  const invoice = await tx.invoice.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: subscriber.branchId,
      subscriberId: subscriber.id,
      subscriptionId: args.subscriptionId ?? null,
      status: "DRAFT",
      currency: org.currency,
      subtotal: totals.subtotal.toFixed(2),
      discountTotal: totals.discountTotal.toFixed(2),
      taxTotal: totals.taxTotal.toFixed(2),
      total: totals.total.toFixed(2),
      balanceDue: totals.total.toFixed(2),
      dueAt: args.dueAt ?? null,
      billingPeriodStart: args.periodStart ?? null,
      billingPeriodEnd: args.periodEnd ?? null,
      generationKey: args.generationKey ?? null,
      source: args.source,
      notes: args.notes ?? null,
      createdById: actorUserId(ctx),
      lines: {
        create: computed.map((l, i) => ({
          position: i + 1,
          description: l.description,
          quantity: l.quantity.toFixed(3),
          unitPrice: l.unitPrice.toFixed(2),
          discount: l.discount.toFixed(2),
          taxRate: l.taxRate.toFixed(2),
          lineSubtotal: l.lineSubtotal.toFixed(2),
          taxAmount: l.taxAmount.toFixed(2),
          lineTotal: l.lineTotal.toFixed(2),
          packageId: l.src.packageId ?? null,
          periodStart: l.src.periodStart ?? null,
          periodEnd: l.src.periodEnd ?? null,
        })),
      },
    },
  });
  if (!args.issue) return { invoice, created: true };
  return { invoice: await issueInvoiceTx(tx, ctx, invoice.id), created: true };
}

/** DRAFT → OPEN: assign the gapless number, set dates, post to the ledger, then apply any customer credit. */
export async function issueInvoiceTx(tx: Tx, ctx: ActorContext, invoiceId: string): Promise<Invoice> {
  const invoice = await lockInvoice(tx, ctx.organizationId, invoiceId);
  if (invoice.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only draft invoices can be issued.");
  if (dec(invoice.total).lte(0)) throw new AppError("INVALID_STATE", "An invoice must have a total greater than zero to be issued.");
  const [settings, org] = await Promise.all([getBillingSettings(tx, ctx.organizationId), tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })]);
  const seq = await nextCounter(tx, ctx.organizationId, "invoice");
  const now = new Date();
  const invoiceNumber = `${settings.invoicePrefix}-${String(seq).padStart(6, "0")}`;
  const base = invoice.billingPeriodStart && invoice.billingPeriodStart > now ? invoice.billingPeriodStart : now;
  // Due dates are whole local days: an invoice due today is not overdue until the day ends.
  const dueAt = endOfLocalDay(invoice.dueAt ?? addLocalDays(base, settings.paymentTermsDays, org.timezone), org.timezone);

  await tx.invoice.update({ where: { id: invoiceId }, data: { status: "OPEN", invoiceNumber, issuedAt: now, dueAt } });
  await postLedger(tx, ctx, {
    type: "invoice.issued",
    sourceType: "invoice",
    sourceId: invoiceId,
    description: `Invoice ${invoiceNumber} issued`,
    currency: invoice.currency,
    occurredAt: now,
    lines: [
      { account: "AR", debit: dec(invoice.total), subscriberId: invoice.subscriberId },
      { account: "REVENUE", credit: dec(invoice.subtotal).minus(dec(invoice.discountTotal)), subscriberId: invoice.subscriberId },
      { account: "TAX_PAYABLE", credit: dec(invoice.taxTotal) },
    ],
  });
  await autoAllocateForSubscriberTx(tx, ctx, invoice.subscriberId);
  const final = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  // Only invoices still owing something are announced (an invoice fully covered by existing credit is not).
  if (final.status !== "PAID") {
    await queueSubscriberNotificationTx(tx, ctx.organizationId, {
      subscriberId: invoice.subscriberId,
      key: "invoice.issued",
      vars: { invoiceNumber, amount: formatMoney(final.balanceDue.toString(), final.currency), dueDate: formatDate(dueAt, org.timezone) },
      dedupeBase: `invoice.issued:${invoiceId}`,
    });
  }
  return final;
}

/** Invoice for one subscription period, built from the subscription's commercial snapshot. Idempotent per period. */
export async function createPeriodInvoiceTx(tx: Tx, ctx: ActorContext, sub: Subscription, period: { start: Date; end: Date }, source: CreateArgs["source"]) {
  const tz = (await tx.organization.findUniqueOrThrow({ where: { id: sub.organizationId }, select: { timezone: true } })).timezone;
  const { invoice, created } = await createInvoiceTx(tx, ctx, {
    subscriberId: sub.subscriberId,
    subscriptionId: sub.id,
    periodStart: period.start,
    periodEnd: period.end,
    generationKey: `sub:${sub.id}:${period.start.toISOString()}`,
    source,
    issue: true,
    lines: [
      {
        description: `${sub.packageName} (${localDateKey(period.start, tz)} to ${localDateKey(period.end, tz)})`,
        quantity: "1",
        unitPrice: dec(sub.price).toFixed(2),
        taxRate: dec(sub.taxRate).toFixed(2),
        packageId: sub.packageId,
        periodStart: period.start,
        periodEnd: period.end,
      },
    ],
  });
  if (!sub.invoicedThrough || period.end > sub.invoicedThrough) {
    await tx.subscription.update({ where: { id: sub.id }, data: { invoicedThrough: period.end } });
  }
  return { invoice, created };
}

/**
 * Recurring billing for one organization: for each ACTIVE auto-renewing subscription whose current period ends
 * within `invoiceLeadDays`, invoice the next period exactly once (generation key = subscription + period start).
 */
export async function runRecurringBilling(ctx: ActorContext, now = new Date()): Promise<{ created: number; skipped: number }> {
  const settings = await getBillingSettings(db, ctx.organizationId);
  const horizon = new Date(now.getTime() + settings.invoiceLeadDays * 86_400_000);
  const due = await db.subscription.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: "ACTIVE",
      autoRenew: true,
      currentPeriodEnd: { lte: horizon },
      billingAnchorAt: { not: null },
    },
    select: { id: true },
    take: 1000,
  });
  let created = 0;
  let skipped = 0;
  const tz = (await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })).timezone;
  for (const { id } of due) {
    const result = await db.$transaction(async (tx) => {
      await lockRow(tx, "Subscription", id);
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id } });
      if (sub.status !== "ACTIVE" || !sub.autoRenew || !sub.billingAnchorAt || !sub.currentPeriodEnd) return false;
      if (sub.invoicedThrough && sub.invoicedThrough > sub.currentPeriodEnd) return false; // next period already invoiced
      const next = periodAt(sub.billingAnchorAt, sub.billingUnit, sub.billingCount, sub.periodIndex + 1, tz);
      const r = await createPeriodInvoiceTx(tx, ctx, sub, next, "recurring");
      return r.created;
    });
    if (result) created++;
    else skipped++;
  }
  return { created, skipped };
}

export async function createManualInvoice(ctx: ActorContext, input: z.infer<typeof invoiceCreateInput>) {
  requirePermission(ctx, "invoices.write");
  if (input.issue) requirePermission(ctx, "invoices.issue");
  const { invoice } = await db.$transaction((tx) =>
    createInvoiceTx(tx, ctx, { subscriberId: input.subscriberId, lines: input.lines, dueAt: input.dueAt, notes: input.notes, source: "manual", issue: input.issue }),
  );
  await audit(ctx, { action: input.issue ? "invoice.create_issue" : "invoice.create_draft", entityType: "invoice", entityId: invoice.id, metadata: { total: invoice.total.toString(), number: invoice.invoiceNumber } });
  return invoice;
}

export async function issueInvoice(ctx: ActorContext, id: string) {
  requirePermission(ctx, "invoices.issue");
  const inv = await db.$transaction((tx) => issueInvoiceTx(tx, ctx, id));
  await audit(ctx, { action: "invoice.issue", entityType: "invoice", entityId: id, metadata: { number: inv.invoiceNumber, total: inv.total.toString() } });
  return inv;
}

export async function deleteDraftInvoice(ctx: ActorContext, id: string) {
  requirePermission(ctx, "invoices.write");
  await db.$transaction(async (tx) => {
    const inv = await lockInvoice(tx, ctx.organizationId, id);
    if (inv.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only drafts can be deleted. Void issued invoices instead.");
    await tx.invoice.delete({ where: { id } });
  });
  await audit(ctx, { action: "invoice.delete_draft", entityType: "invoice", entityId: id });
}

/** Void an issued invoice that has no payments or credits applied; the ledger posting is reversed. */
export async function voidInvoice(ctx: ActorContext, id: string, reason: string) {
  requirePermission(ctx, "invoices.issue");
  const inv = await db.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, ctx.organizationId, id);
    if (invoice.status === "VOID") throw new AppError("CONFLICT", "This invoice is already void.");
    if (invoice.status === "DRAFT") throw new AppError("INVALID_STATE", "Delete drafts instead of voiding them.");
    if (dec(invoice.amountPaid).gt(0) || dec(invoice.amountCredited).gt(0)) {
      throw new AppError("INVALID_STATE", "Reverse the payments allocated to this invoice (or issue a credit note) before voiding it.");
    }
    const voided = await tx.invoice.update({ where: { id }, data: { status: "VOID", voidedAt: new Date(), voidReason: reason, balanceDue: "0" } });
    await postLedger(tx, ctx, {
      type: "invoice.voided",
      sourceType: "invoice",
      sourceId: id,
      description: `Invoice ${invoice.invoiceNumber} voided: ${reason}`,
      currency: invoice.currency,
      lines: [
        { account: "REVENUE", debit: dec(invoice.subtotal).minus(dec(invoice.discountTotal)), subscriberId: invoice.subscriberId },
        { account: "TAX_PAYABLE", debit: dec(invoice.taxTotal) },
        { account: "AR", credit: dec(invoice.total), subscriberId: invoice.subscriberId },
      ],
    });
    if (invoice.subscriptionId && invoice.billingPeriodStart) {
      // Allow the period to be invoiced again if needed.
      const sub = await tx.subscription.findUnique({ where: { id: invoice.subscriptionId } });
      if (sub?.invoicedThrough && invoice.billingPeriodEnd && sub.invoicedThrough.getTime() === invoice.billingPeriodEnd.getTime()) {
        await tx.subscription.update({ where: { id: sub.id }, data: { invoicedThrough: invoice.billingPeriodStart } });
      }
      await tx.invoice.update({ where: { id }, data: { generationKey: `void:${id}` } });
    }
    return voided;
  });
  await audit(ctx, { action: "invoice.void", entityType: "invoice", entityId: id, metadata: { reason, number: inv.invoiceNumber } });
  return inv;
}

/**
 * Credit note against an issued invoice (gross amount incl. tax, up to total − prior credits).
 * The part up to the open balance reduces the invoice; any remainder becomes customer credit (refundable or usable later).
 */
export async function createCreditNote(ctx: ActorContext, invoiceId: string, input: z.infer<typeof creditNoteInput>) {
  requirePermission(ctx, "credit_notes.create");
  const amount = new D(input.amount);
  const note = await db.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, ctx.organizationId, invoiceId);
    if (invoice.status === "DRAFT" || invoice.status === "VOID") throw new AppError("INVALID_STATE", `A ${invoice.status.toLowerCase()} invoice cannot be credited.`);
    const prior = await tx.creditNote.aggregate({ where: { invoiceId }, _sum: { total: true } });
    const creditable = dec(invoice.total).minus(dec(prior._sum.total ?? 0));
    if (amount.gt(creditable)) throw new AppError("INVALID_STATE", `At most ${creditable.toFixed(2)} ${invoice.currency} can still be credited on this invoice.`);
    const split = splitCreditNote(amount, { total: dec(invoice.total), taxTotal: dec(invoice.taxTotal), balanceDue: dec(invoice.balanceDue) });
    const settings = await getBillingSettings(tx, ctx.organizationId);
    const seq = await nextCounter(tx, ctx.organizationId, "credit_note");
    const cn = await tx.creditNote.create({
      data: {
        organizationId: ctx.organizationId,
        invoiceId,
        subscriberId: invoice.subscriberId,
        creditNoteNumber: `${settings.creditNotePrefix}-${String(seq).padStart(6, "0")}`,
        reason: input.reason,
        currency: invoice.currency,
        subtotal: split.net.toFixed(2),
        taxTotal: split.tax.toFixed(2),
        total: amount.toFixed(2),
        appliedToInvoice: split.appliedToInvoice.toFixed(2),
        toCustomerCredit: split.toCustomerCredit.toFixed(2),
        createdById: actorUserId(ctx),
        lines: { create: [{ description: `Credit against ${invoice.invoiceNumber}: ${input.reason}`.slice(0, 300), amount: split.net.toFixed(2), taxAmount: split.tax.toFixed(2) }] },
      },
    });
    if (split.appliedToInvoice.gt(0)) await adjustInvoiceSettlementTx(tx, invoice, { credited: split.appliedToInvoice });
    await postLedger(tx, ctx, {
      type: "credit_note",
      sourceType: "credit_note",
      sourceId: cn.id,
      description: `Credit note ${cn.creditNoteNumber} on ${invoice.invoiceNumber}`,
      currency: invoice.currency,
      lines: [
        { account: "ALLOWANCES", debit: split.net, subscriberId: invoice.subscriberId },
        { account: "TAX_PAYABLE", debit: split.tax },
        { account: "AR", credit: split.appliedToInvoice, subscriberId: invoice.subscriberId },
        { account: "CUSTOMER_CREDIT", credit: split.toCustomerCredit, subscriberId: invoice.subscriberId },
      ],
    });
    return cn;
  });
  await audit(ctx, { action: "credit_note.create", entityType: "invoice", entityId: invoiceId, metadata: { creditNoteId: note.id, number: note.creditNoteNumber, amount: note.total.toString(), reason: input.reason } });
  return note;
}

export async function listInvoices(ctx: ActorContext, query: z.infer<typeof invoiceListQuery>) {
  requirePermission(ctx, "invoices.read");
  const q = searchTerm(query.q);
  const now = new Date();
  const statusWhere: Prisma.InvoiceWhereInput =
    query.status === "ALL"
      ? {}
      : query.status === "OVERDUE"
        ? { status: { in: ["OPEN", "PARTIALLY_PAID"] }, dueAt: { lt: now } }
        : query.status === "UNPAID"
          ? { status: { in: ["OPEN", "PARTIALLY_PAID"] } }
          : { status: query.status };
  const where: Prisma.InvoiceWhereInput = {
    ...listWhere(ctx),
    ...statusWhere,
    ...(query.subscriberId ? { subscriberId: query.subscriberId } : {}),
    ...(q ? { OR: [{ invoiceNumber: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total, sums] = await Promise.all([
    db.invoice.findMany({ where, orderBy: [{ issuedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.invoice.count({ where }),
    db.invoice.aggregate({ where: { ...where, status: { in: ["OPEN", "PARTIALLY_PAID"] } }, _sum: { balanceDue: true } }),
  ]);
  const subscribers = await db.subscriber.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subscriberId))] } }, select: { id: true, displayName: true, accountNumber: true } });
  const byId = new Map(subscribers.map((s) => [s.id, s]));
  return { rows: rows.map((r) => ({ ...r, subscriber: byId.get(r.subscriberId) ?? null, overdue: (r.status === "OPEN" || r.status === "PARTIALLY_PAID") && !!r.dueAt && r.dueAt < now })), total, outstanding: (sums._sum.balanceDue ?? new D(0)).toString() };
}

export async function getInvoice(ctx: ActorContext, id: string) {
  requirePermission(ctx, "invoices.read");
  const invoice = await db.invoice.findFirst({
    where: { id, ...tenantWhere(ctx) },
    include: {
      lines: { orderBy: { position: "asc" } },
      allocations: { orderBy: { createdAt: "asc" }, include: { payment: { select: { id: true, receiptNumber: true, method: true, receivedAt: true, status: true } } } },
      creditNotes: { orderBy: { issuedAt: "asc" } },
    },
  });
  if (!invoice) throw notFound("invoice");
  const subscriber = await db.subscriber.findUniqueOrThrow({ where: { id: invoice.subscriberId }, select: { id: true, displayName: true, accountNumber: true, phone: true, email: true, addresses: { take: 1 } } });
  return { ...invoice, subscriber, overdue: (invoice.status === "OPEN" || invoice.status === "PARTIALLY_PAID") && !!invoice.dueAt && invoice.dueAt < new Date() };
}
