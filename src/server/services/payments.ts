import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { listWhere, requirePermission, resolveBranchForCreate, tenantWhere, type ActorContext, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { D, positiveMoneyInput } from "@/server/domain/money";
import { periodFields, resolvePeriod, type ResolvedPeriod } from "@/server/domain/periods";
import { actorUserId, nextCounter, searchTerm } from "@/server/services/common";
import { cashAccountFor, postLedger } from "@/server/services/ledger";
import { dispatchNetworkOperations } from "@/server/services/network";
import { allocateTx, autoAllocateForSubscriberTx, lockPayment, reverseAllocationTx, unallocatedOf, type AllocationResult } from "@/server/services/settlement";
import { getBillingSettings } from "@/server/services/invoices";
import { queueSubscriberNotificationTx } from "@/server/services/notifications";
import { subscriberLedgerBalance } from "@/server/services/ledger";
import { formatMoney } from "@/lib/utils";
import type { Payment, PaymentMethod, Prisma } from "@/generated/prisma/client";

const dec = (v: { toString(): string }) => new D(v.toString());
const METHODS = ["CASH", "BANK_TRANSFER", "MPESA", "CHEQUE", "CARD", "OTHER"] as const;

export const manualPaymentInput = z
  .object({
    subscriberId: z.uuid().nullable().optional(), // null = unidentified receipt, reconciled later
    amount: positiveMoneyInput,
    method: z.enum(METHODS),
    receivedAt: z.coerce.date(),
    reference: z.string().trim().max(100).optional().nullable(),
    payerName: z.string().trim().max(120).optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
    branchId: z.uuid().optional().nullable(),
    allocations: z.array(z.object({ invoiceId: z.uuid(), amount: positiveMoneyInput })).max(50).optional(),
    autoAllocate: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.method !== "CASH" && !v.reference) ctx.addIssue({ code: "custom", path: ["reference"], message: "A transaction/bank reference is required for non-cash payments." });
    if (v.receivedAt.getTime() > Date.now() + 5 * 60_000) ctx.addIssue({ code: "custom", path: ["receivedAt"], message: "The payment date cannot be in the future." });
    if (!v.subscriberId && v.allocations?.length) ctx.addIssue({ code: "custom", path: ["allocations"], message: "Unidentified receipts cannot be allocated until matched." });
  });

export const allocateInput = z.object({ allocations: z.array(z.object({ invoiceId: z.uuid(), amount: positiveMoneyInput })).min(1).max(50) });
export const refundInput = z.object({ amount: positiveMoneyInput, method: z.enum(METHODS), reference: z.string().trim().max(100).optional().nullable(), reason: z.string().trim().min(3).max(500) });
export const reverseInput = z.object({ reason: z.string().trim().min(3).max(500) });
export const reconcileInput = z.object({ subscriberId: z.uuid(), autoAllocate: z.boolean().default(true) });
export const paymentListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["PENDING", "CONFIRMED", "FAILED", "CANCELLED", "REVERSED", "UNKNOWN", "ALL"]).default("ALL"),
  method: z.enum(METHODS).optional(),
  subscriberId: z.uuid().optional(),
  unmatched: z.enum(["1"]).optional(),
  /** hotspot = bought on the captive portal; stk = M-Pesa prompt for an account; c2b = paybill/till; manual = entered by staff. */
  type: z.enum(["hotspot", "stk", "c2b", "manual"]).optional(),
  ...periodFields,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaymentType = "hotspot" | "stk" | "c2b" | "manual";
export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = { hotspot: "Hotspot purchase", stk: "M-Pesa prompt", c2b: "Paybill / till", manual: "Recorded by staff" };


export async function nextReceiptNumber(tx: Tx, organizationId: string): Promise<string> {
  const settings = await getBillingSettings(tx, organizationId);
  return `${settings.receiptPrefix}-${String(await nextCounter(tx, organizationId, "receipt")).padStart(6, "0")}`;
}

/** A live (not reversed) payment already carrying this provider reference, from any path (manual, STK, C2B). */
export async function findLivePaymentByReference(tx: Tx, organizationId: string, reference: string) {
  return tx.payment.findFirst({ where: { organizationId, providerTransactionId: reference, status: { not: "REVERSED" } }, select: { id: true, receiptNumber: true, subscriberId: true } });
}

export interface ConfirmedPaymentData {
  subscriberId: string | null;
  branchId: string | null;
  method: PaymentMethod;
  provider: string;
  /** How the money arrived (see Payment.source). */
  source: PaymentType;
  providerTransactionId: string | null;
  amount: string;
  currency: string;
  receivedAt: Date;
  payerName?: string | null;
  payerPhone?: string | null;
  accountReference?: string | null;
  notes?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Create a CONFIRMED payment with a gapless receipt number and its ledger posting (cash/M-Pesa debit; customer
 * credit, or unidentified receipts when no subscriber is known). Shared by manual entry and gateway confirmations.
 * Callers allocate, notify and audit.
 */
export async function createConfirmedPaymentTx(tx: Tx, ctx: ActorContext, p: ConfirmedPaymentData): Promise<Payment> {
  const payment = await tx.payment.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: p.branchId,
      subscriberId: p.subscriberId,
      method: p.method,
      provider: p.provider,
      source: p.source,
      providerTransactionId: p.providerTransactionId,
      receiptNumber: await nextReceiptNumber(tx, ctx.organizationId),
      amount: p.amount,
      currency: p.currency,
      status: "CONFIRMED",
      receivedAt: p.receivedAt,
      payerName: p.payerName ?? null,
      payerPhone: p.payerPhone ?? null,
      accountReference: p.accountReference ?? null,
      notes: p.notes ?? null,
      recordedById: actorUserId(ctx),
      ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
    },
  });
  await postLedger(tx, ctx, {
    type: "payment.received",
    sourceType: "payment",
    sourceId: payment.id,
    description: `Payment ${payment.receiptNumber} (${p.provider === "manual" ? p.method.toLowerCase().replace("_", " ") : p.provider === "mock" ? "simulated M-Pesa" : "M-Pesa"})`,
    currency: payment.currency,
    occurredAt: p.receivedAt,
    lines: [
      { account: cashAccountFor(p.method), debit: dec(payment.amount) },
      p.subscriberId ? { account: "CUSTOMER_CREDIT", credit: dec(payment.amount), subscriberId: p.subscriberId } : { account: "UNIDENTIFIED", credit: dec(payment.amount) },
    ],
  });
  return payment;
}

/**
 * Record a confirmed payment received outside a gateway (cash, bank, cheque, manual M-Pesa entry).
 * One transaction: payment + receipt number + ledger + allocations (explicit, or oldest-first) + renewals.
 * Non-cash references are unique per organization, so the same bank/M-Pesa reference cannot be recorded twice.
 */
export async function recordManualPayment(ctx: ActorContext, input: z.infer<typeof manualPaymentInput>) {
  requirePermission(ctx, "payments.record");
  if (input.allocations?.length) requirePermission(ctx, "payments.allocate");
  const result = await db.$transaction(async (tx) => {
    let branchId: string | null = null;
    if (input.subscriberId) {
      const sub = await tx.subscriber.findFirst({ where: { id: input.subscriberId, ...tenantWhere(ctx) }, select: { id: true, branchId: true } });
      if (!sub) throw notFound("subscriber");
      branchId = sub.branchId;
    } else {
      branchId = await resolveBranchForCreate(ctx, input.branchId);
    }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
    const reference = input.reference?.toUpperCase() ?? null;
    if (reference) {
      const dup = await findLivePaymentByReference(tx, ctx.organizationId, reference);
      if (dup) throw new AppError("CONFLICT", `A payment with reference ${reference} is already recorded (${dup.receiptNumber}).`);
    }
    const payment = await createConfirmedPaymentTx(tx, ctx, {
      subscriberId: input.subscriberId ?? null,
      branchId,
      method: input.method,
      provider: "manual",
      source: "manual",
      providerTransactionId: reference,
      amount: input.amount,
      currency: org.currency,
      receivedAt: input.receivedAt,
      payerName: input.payerName ?? null,
      notes: input.notes ?? null,
    });
    let allocations: AllocationResult[] = [];
    if (input.subscriberId) {
      if (input.allocations?.length) {
        for (const a of input.allocations) allocations.push(await allocateTx(tx, ctx, payment.id, a.invoiceId, new D(a.amount)));
      } else if (input.autoAllocate) {
        allocations = await autoAllocateForSubscriberTx(tx, ctx, input.subscriberId, payment.id);
      }
    }
    if (input.subscriberId) await notifyPaymentReceivedTx(tx, ctx.organizationId, payment.id);
    return { payment: await tx.payment.findUniqueOrThrow({ where: { id: payment.id } }), allocations };
  });
  await dispatchRenewalNetwork(ctx.organizationId, result.allocations);
  await audit(ctx, {
    action: "payment.record_manual",
    entityType: "payment",
    entityId: result.payment.id,
    metadata: { receipt: result.payment.receiptNumber, amount: result.payment.amount.toString(), method: input.method, subscriberId: input.subscriberId ?? null, allocations: result.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) },
  });
  return result;
}

/** A paid period invoice can renew a lapsed subscription, which queues a network enable; push it right away. */
async function dispatchRenewalNetwork(organizationId: string, allocations: AllocationResult[]) {
  if (allocations.some((a) => a.subscription === "renewed")) await dispatchNetworkOperations(organizationId);
}

export async function allocatePayment(ctx: ActorContext, paymentId: string, input: z.infer<typeof allocateInput>) {
  requirePermission(ctx, "payments.allocate");
  await assertVisible(ctx, paymentId);
  const results = await db.$transaction(async (tx) => {
    const out: AllocationResult[] = [];
    for (const a of input.allocations) out.push(await allocateTx(tx, ctx, paymentId, a.invoiceId, new D(a.amount)));
    return out;
  });
  await dispatchRenewalNetwork(ctx.organizationId, results);
  await audit(ctx, { action: "payment.allocate", entityType: "payment", entityId: paymentId, metadata: { allocations: results.map((r) => ({ invoiceId: r.invoiceId, amount: r.amount })) } });
  return results;
}

export async function reverseAllocation(ctx: ActorContext, paymentId: string, allocationId: string, reason: string) {
  requirePermission(ctx, "payments.reconcile");
  await assertVisible(ctx, paymentId);
  const alloc = await db.paymentAllocation.findFirst({ where: { id: allocationId, paymentId, organizationId: ctx.organizationId } });
  if (!alloc) throw notFound("allocation");
  const result = await db.$transaction((tx) => reverseAllocationTx(tx, ctx, allocationId, reason));
  await audit(ctx, { action: "payment.allocation_reversed", entityType: "payment", entityId: paymentId, metadata: { allocationId, reason, amount: result.amount } });
  return result;
}

/** Refund part of a payment's unallocated amount back to the payer. */
export async function refundPayment(ctx: ActorContext, paymentId: string, input: z.infer<typeof refundInput>) {
  requirePermission(ctx, "payments.refund");
  await assertVisible(ctx, paymentId);
  const amount = new D(input.amount);
  const refund = await db.$transaction(async (tx) => {
    const payment = await lockPayment(tx, ctx.organizationId, paymentId);
    if (payment.status !== "CONFIRMED") throw new AppError("INVALID_STATE", "Only confirmed payments can be refunded.");
    if (!payment.subscriberId) throw new AppError("INVALID_STATE", "Match this payment to a subscriber (or reverse it) before refunding.");
    const available = unallocatedOf(payment);
    if (amount.gt(available)) throw new AppError("INVALID_STATE", `Only ${available.toFixed(2)} ${payment.currency} is unallocated. Reverse allocations first to refund more.`);
    const r = await tx.refund.create({
      data: { organizationId: ctx.organizationId, paymentId, subscriberId: payment.subscriberId, amount: amount.toFixed(2), currency: payment.currency, method: input.method, reference: input.reference ?? null, reason: input.reason, createdById: actorUserId(ctx) },
    });
    await tx.payment.update({ where: { id: paymentId }, data: { refundedAmount: dec(payment.refundedAmount).plus(amount).toFixed(2) } });
    await postLedger(tx, ctx, {
      type: "refund",
      sourceType: "refund",
      sourceId: r.id,
      description: `Refund on ${payment.receiptNumber}: ${input.reason}`,
      currency: payment.currency,
      lines: [
        { account: "CUSTOMER_CREDIT", debit: amount, subscriberId: payment.subscriberId },
        { account: cashAccountFor(input.method), credit: amount },
      ],
    });
    return r;
  });
  await audit(ctx, { action: "payment.refund", entityType: "payment", entityId: paymentId, metadata: { refundId: refund.id, amount: refund.amount.toString(), reason: input.reason } });
  return refund;
}

/**
 * Reverse a payment entered in error or bounced: all active allocations are reversed, then the receipt itself.
 * Refunded payments cannot be reversed (the money already left).
 */
export async function reversePayment(ctx: ActorContext, paymentId: string, reason: string) {
  requirePermission(ctx, "payments.refund");
  await assertVisible(ctx, paymentId);
  const reversed = await db.$transaction(async (tx) => {
    const payment = await lockPayment(tx, ctx.organizationId, paymentId);
    if (payment.status === "REVERSED") throw new AppError("CONFLICT", "This payment is already reversed.");
    if (payment.status !== "CONFIRMED") throw new AppError("INVALID_STATE", "Only confirmed payments can be reversed.");
    if (dec(payment.refundedAmount).gt(0)) throw new AppError("INVALID_STATE", "Payments with refunds cannot be reversed.");
    const active = await tx.paymentAllocation.findMany({ where: { paymentId, status: "ACTIVE" }, select: { id: true } });
    for (const a of active) await reverseAllocationTx(tx, ctx, a.id, `Payment reversed: ${reason}`);
    const after = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await postLedger(tx, ctx, {
      type: "payment.reversed",
      sourceType: "payment",
      sourceId: paymentId,
      description: `Payment ${payment.receiptNumber} reversed: ${reason}`,
      currency: payment.currency,
      lines: [
        payment.subscriberId ? { account: "CUSTOMER_CREDIT", debit: dec(after.amount), subscriberId: payment.subscriberId } : { account: "UNIDENTIFIED", debit: dec(after.amount) },
        { account: cashAccountFor(payment.method), credit: dec(after.amount) },
      ],
    });
    // Manual references are released so a corrected entry can reuse them; gateway references stay unique forever.
    const release = payment.provider === "manual" && payment.providerTransactionId;
    return tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "REVERSED",
        reversedAt: new Date(),
        reversalReason: reason,
        ...(release ? { providerTransactionId: null, metadata: { ...((payment.metadata as object) ?? {}), originalReference: payment.providerTransactionId } } : {}),
      },
    });
  });
  await audit(ctx, { action: "payment.reverse", entityType: "payment", entityId: paymentId, metadata: { reason, amount: reversed.amount.toString() } });
  return reversed;
}

/** Match an unidentified receipt to a subscriber, then optionally allocate it to their open invoices. */
export async function reconcilePayment(ctx: ActorContext, paymentId: string, input: z.infer<typeof reconcileInput>) {
  requirePermission(ctx, "payments.reconcile");
  await assertVisible(ctx, paymentId);
  const result = await db.$transaction(async (tx) => {
    const payment = await lockPayment(tx, ctx.organizationId, paymentId);
    if (payment.status !== "CONFIRMED") throw new AppError("INVALID_STATE", "Only confirmed payments can be matched.");
    if (payment.subscriberId) throw new AppError("CONFLICT", "This payment is already matched to a subscriber.");
    const sub = await tx.subscriber.findFirst({ where: { id: input.subscriberId, ...tenantWhere(ctx) }, select: { id: true, branchId: true } });
    if (!sub) throw notFound("subscriber");
    await tx.payment.update({ where: { id: paymentId }, data: { subscriberId: sub.id, branchId: payment.branchId ?? sub.branchId } });
    await postLedger(tx, ctx, {
      type: "payment.matched",
      sourceType: "payment",
      sourceId: paymentId,
      description: `Payment ${payment.receiptNumber} matched to subscriber`,
      currency: payment.currency,
      lines: [
        { account: "UNIDENTIFIED", debit: dec(payment.amount) },
        { account: "CUSTOMER_CREDIT", credit: dec(payment.amount), subscriberId: sub.id },
      ],
    });
    await tx.reconciliationRecord.create({
      data: { organizationId: ctx.organizationId, paymentId, action: "matched", outcome: "assigned", details: { subscriberId: sub.id }, actorUserId: actorUserId(ctx) },
    });
    const allocations = input.autoAllocate ? await autoAllocateForSubscriberTx(tx, ctx, sub.id, paymentId) : [];
    await notifyPaymentReceivedTx(tx, ctx.organizationId, paymentId);
    return { allocations };
  });
  await dispatchRenewalNetwork(ctx.organizationId, result.allocations);
  await audit(ctx, { action: "payment.reconcile", entityType: "payment", entityId: paymentId, metadata: { subscriberId: input.subscriberId, allocations: result.allocations.length } });
  return result;
}

/** Queue the payment confirmation message (receipt number + resulting balance). Idempotent per payment. */
export async function notifyPaymentReceivedTx(tx: Tx, organizationId: string, paymentId: string) {
  const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (!p.subscriberId || p.status !== "CONFIRMED") return;
  const bal = await subscriberLedgerBalance(tx, organizationId, p.subscriberId);
  const balance = bal.net.gt(0) ? `${formatMoney(bal.net.toFixed(2), p.currency)} due` : bal.net.lt(0) ? `${formatMoney(bal.net.abs().toFixed(2), p.currency)} credit` : "fully paid";
  await queueSubscriberNotificationTx(tx, organizationId, {
    subscriberId: p.subscriberId,
    key: "payment.received",
    vars: { amount: formatMoney(p.amount.toString(), p.currency), receiptNumber: p.receiptNumber ?? "", balance },
    dedupeBase: `payment.received:${paymentId}`,
  });
  // Part of the payment was not needed by any invoice: tell the customer it is kept for the next bill.
  const credit = p.amount.minus(p.allocatedAmount).minus(p.refundedAmount);
  if (credit.gt(0)) {
    await queueSubscriberNotificationTx(tx, organizationId, {
      subscriberId: p.subscriberId,
      key: "credit.saved",
      vars: { amount: formatMoney(p.amount.toString(), p.currency), credit: formatMoney(credit.toFixed(2), p.currency) },
      dedupeBase: `credit.saved:${paymentId}`,
    });
  }
}

async function assertVisible(ctx: ActorContext, paymentId: string) {
  const p = await db.payment.findFirst({ where: { id: paymentId, ...tenantWhere(ctx) }, select: { id: true } });
  if (!p) throw notFound("payment");
}

function paymentWhere(ctx: ActorContext, query: z.infer<typeof paymentListQuery>, period: ResolvedPeriod | null): Prisma.PaymentWhereInput {
  const q = searchTerm(query.q);
  return {
    ...listWhere(ctx),
    ...(query.method ? { method: query.method } : {}),
    ...(query.type ? { source: query.type } : {}),
    ...(query.subscriberId ? { subscriberId: query.subscriberId } : {}),
    ...(period ? { receivedAt: { gte: period.start, lt: period.end } } : {}),
    ...(q ? { OR: [{ receiptNumber: { contains: q, mode: "insensitive" } }, { providerTransactionId: { contains: q.toUpperCase() } }, { payerName: { contains: q, mode: "insensitive" } }] } : {}),
  };
}

/** Reconciliation state of a payment, for the list: where its money went. */
export function reconciliationOf(p: { status: string; subscriberId: string | null; amount: { toString(): string }; allocatedAmount: { toString(): string }; refundedAmount: { toString(): string } }) {
  if (p.status !== "CONFIRMED") return null;
  if (!p.subscriberId) return "unmatched" as const;
  const unallocated = new D(p.amount.toString()).minus(p.allocatedAmount.toString()).minus(p.refundedAmount.toString());
  if (unallocated.lte(0)) return "allocated" as const;
  return new D(p.allocatedAmount.toString()).gt(0) ? ("partly_allocated" as const) : ("credit" as const);
}

export async function listPayments(ctx: StaffContext, raw: z.input<typeof paymentListQuery>) {
  requirePermission(ctx, "payments.read");
  const query = paymentListQuery.parse(raw);
  const period = resolvePeriod(query, ctx.organization.timezone);
  const where: Prisma.PaymentWhereInput = {
    ...paymentWhere(ctx, query, period),
    ...(query.status !== "ALL" ? { status: query.status } : {}),
    ...(query.unmatched ? { subscriberId: null, status: "CONFIRMED" } : {}),
  };
  const [rows, total, sum] = await Promise.all([
    db.payment.findMany({ where, orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.payment.count({ where }),
    db.payment.aggregate({ where: { ...where, status: "CONFIRMED" }, _sum: { amount: true } }),
  ]);
  const ids = rows.map((r) => r.id);
  const [subs, attempts] = await Promise.all([
    db.subscriber.findMany({ where: { id: { in: rows.map((r) => r.subscriberId).filter((v): v is string => Boolean(v)) } }, select: { id: true, displayName: true, accountNumber: true } }),
    ids.length ? db.paymentAttempt.findMany({ where: { organizationId: ctx.organizationId, paymentId: { in: ids } }, select: { paymentId: true, purpose: true, completedAt: true, activatedAt: true } }) : [],
  ]);
  const byId = new Map(subs.map((s) => [s.id, s]));
  return {
    rows: rows.map((r) => {
      const attempt = attempts.find((a) => a.paymentId === r.id);
      // Hotspot purchases: how long after the payment was confirmed the customer's access was confirmed on the router.
      const activation =
        attempt?.purpose === "hotspot_purchase"
          ? { activatedAt: attempt.activatedAt, seconds: attempt.activatedAt && attempt.completedAt ? Math.max(0, Math.round((attempt.activatedAt.getTime() - attempt.completedAt.getTime()) / 1000)) : null }
          : null;
      return {
        ...r,
        unallocated: unallocatedOf(r).toFixed(2),
        subscriber: r.subscriberId ? (byId.get(r.subscriberId) ?? null) : null,
        reconciliation: reconciliationOf(r),
        activation,
      };
    }),
    total,
    confirmedTotal: (sum._sum.amount ?? new D(0)).toString(),
    period,
  };
}

/**
 * Figures for the payments page, for the period and the method / type / search filters (not the status tab):
 * confirmed total and count, by method, unmatched, credit left on accounts, reversals. Organization currency only.
 */
export async function paymentPeriodSummary(ctx: StaffContext, raw: z.input<typeof paymentListQuery>) {
  requirePermission(ctx, "payments.read");
  const query = paymentListQuery.parse(raw);
  const period = resolvePeriod(query, ctx.organization.timezone);
  const base: Prisma.PaymentWhereInput = { ...paymentWhere(ctx, query, period), currency: ctx.organization.currency };
  const confirmed: Prisma.PaymentWhereInput = { ...base, status: "CONFIRMED" };
  const [all, byMethod, bySource, unmatched, matched, reversed] = await Promise.all([
    db.payment.aggregate({ where: confirmed, _sum: { amount: true }, _count: { _all: true } }),
    db.payment.groupBy({ by: ["method"], where: confirmed, _sum: { amount: true }, _count: { _all: true } }),
    db.payment.groupBy({ by: ["source"], where: confirmed, _sum: { amount: true }, _count: { _all: true } }),
    db.payment.aggregate({ where: { ...confirmed, subscriberId: null }, _sum: { amount: true }, _count: { _all: true } }),
    db.payment.aggregate({ where: { ...confirmed, subscriberId: { not: null } }, _sum: { amount: true, allocatedAmount: true, refundedAmount: true } }),
    db.payment.aggregate({ where: { ...base, status: "REVERSED" }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const money = (v: Prisma.Decimal | null | undefined) => new D((v ?? 0).toString()).toFixed(2);
  const credit = new D((matched._sum.amount ?? 0).toString()).minus((matched._sum.allocatedAmount ?? 0).toString()).minus((matched._sum.refundedAmount ?? 0).toString());
  return {
    currency: ctx.organization.currency,
    period,
    collected: money(all._sum.amount),
    payments: all._count._all,
    byMethod: byMethod.map((m) => ({ method: m.method, amount: money(m._sum.amount), payments: m._count._all })).sort((a, b) => Number(b.amount) - Number(a.amount)),
    bySource: bySource.map((m) => ({ source: m.source as PaymentType, amount: money(m._sum.amount), payments: m._count._all })).sort((a, b) => Number(b.amount) - Number(a.amount)),
    unmatched: { amount: money(unmatched._sum.amount), payments: unmatched._count._all },
    creditOnAccounts: credit.gt(0) ? credit.toFixed(2) : "0.00",
    reversed: { amount: money(reversed._sum.amount), payments: reversed._count._all },
  };
}

export async function getPayment(ctx: ActorContext, id: string) {
  requirePermission(ctx, "payments.read");
  await assertVisible(ctx, id);
  const p = await db.payment.findUniqueOrThrow({
    where: { id },
    include: { allocations: { orderBy: { createdAt: "asc" }, include: { invoice: { select: { id: true, invoiceNumber: true, total: true, status: true } } } }, refunds: { orderBy: { refundedAt: "asc" } } },
  });
  const subscriber = p.subscriberId ? await db.subscriber.findUnique({ where: { id: p.subscriberId }, select: { id: true, displayName: true, accountNumber: true, phone: true } }) : null;
  const recorder = p.recordedById ? await db.user.findUnique({ where: { id: p.recordedById }, select: { name: true } }) : null;
  return { ...p, subscriber, recordedBy: recorder?.name ?? null, unallocated: unallocatedOf(p).toFixed(2) };
}

export type PaymentWithSettlement = Payment & { unallocated: string };
export const PAYMENT_METHODS: PaymentMethod[] = [...METHODS];
