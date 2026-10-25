import "server-only";
import type { Tx } from "@/server/db/client";
import type { ActorContext } from "@/server/auth/context";
import { AppError, notFound } from "@/server/errors";
import { D, type DecimalValue } from "@/server/domain/money";
import { allocateInOrder, settledStatus } from "@/server/domain/invoice-math";
import { actorUserId } from "@/server/services/common";
import { postLedger } from "@/server/services/ledger";
import { applyActionTx } from "@/server/services/subscriptions";
import type { Invoice } from "@/generated/prisma/client";

/**
 * Settlement primitives shared by invoices and payments. All functions run inside the caller's transaction.
 * Lock order is always Payment → Invoice → Subscription to avoid deadlocks.
 */

const dec = (v: { toString(): string }) => new D(v.toString());

export async function lockPayment(tx: Tx, organizationId: string, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Payment" WHERE "id" = ${id}::uuid AND "organizationId" = ${organizationId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound("payment");
  return tx.payment.findUniqueOrThrow({ where: { id } });
}

export async function lockInvoice(tx: Tx, organizationId: string, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Invoice" WHERE "id" = ${id}::uuid AND "organizationId" = ${organizationId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound("invoice");
  return tx.invoice.findUniqueOrThrow({ where: { id } });
}

export function unallocatedOf(p: { amount: { toString(): string }; allocatedAmount: { toString(): string }; refundedAmount: { toString(): string } }): DecimalValue {
  return dec(p.amount).minus(dec(p.allocatedAmount)).minus(dec(p.refundedAmount));
}

/** Apply paid/credited deltas to a locked invoice and recompute balance and status. */
export async function adjustInvoiceSettlementTx(tx: Tx, invoice: Invoice, delta: { paid?: DecimalValue; credited?: DecimalValue }) {
  if (invoice.status === "DRAFT" || invoice.status === "VOID") throw new AppError("INVALID_STATE", `A ${invoice.status.toLowerCase()} invoice cannot be settled.`);
  const amountPaid = dec(invoice.amountPaid).plus(delta.paid ?? 0);
  const amountCredited = dec(invoice.amountCredited).plus(delta.credited ?? 0);
  const total = dec(invoice.total);
  const balanceDue = total.minus(amountPaid).minus(amountCredited);
  if (balanceDue.lt(0)) throw new AppError("INVALID_STATE", "This would settle more than the invoice balance.");
  if (amountPaid.lt(0) || amountCredited.lt(0)) throw new AppError("INVALID_STATE", "Settlement cannot go below zero.");
  const status = settledStatus(total, balanceDue);
  return tx.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid: amountPaid.toFixed(2),
      amountCredited: amountCredited.toFixed(2),
      balanceDue: balanceDue.toFixed(2),
      status,
      paidAt: status === "PAID" ? (invoice.paidAt ?? new Date()) : null,
    },
  });
}

/**
 * When an invoice for a subscription period becomes fully paid, extend service for that period.
 * - Period already covered (e.g. activation invoice): nothing to do.
 * - Otherwise renew with idempotency key `invoice:<id>` (continues seamlessly, or restarts if lapsed).
 * - Cancelled subscriptions are never renewed; suspended ones are left for staff to reactivate.
 */
export async function applyPaidInvoiceToSubscriptionTx(tx: Tx, ctx: ActorContext, invoice: Invoice): Promise<"renewed" | "covered" | "skipped" | "none"> {
  if (!invoice.subscriptionId || !invoice.billingPeriodEnd) return "none";
  const sub = await tx.subscription.findUnique({ where: { id: invoice.subscriptionId } });
  if (!sub || sub.status === "CANCELLED" || sub.status === "SUSPENDED") return "skipped";
  if (sub.status === "ACTIVE" && sub.currentPeriodEnd && invoice.billingPeriodEnd.getTime() <= sub.currentPeriodEnd.getTime()) return "covered";
  const renewed = await applyActionTx(tx, ctx, sub.id, "renew", { idempotencyKey: `invoice:${invoice.id}`, reason: `Invoice ${invoice.invoiceNumber} paid` });
  const through = renewed.currentPeriodEnd && (!renewed.invoicedThrough || renewed.currentPeriodEnd > renewed.invoicedThrough) ? renewed.currentPeriodEnd : renewed.invoicedThrough;
  await tx.subscription.update({ where: { id: sub.id }, data: { invoicedThrough: through } });
  return "renewed";
}

export interface AllocationResult {
  allocationId: string;
  invoiceId: string;
  amount: string;
  invoiceStatus: string;
  subscription: "renewed" | "covered" | "skipped" | "none";
}

/** Allocate part of a confirmed payment to an invoice of the same subscriber and currency. */
export async function allocateTx(tx: Tx, ctx: ActorContext, paymentId: string, invoiceId: string, amount: DecimalValue): Promise<AllocationResult> {
  if (amount.lte(0)) throw new AppError("VALIDATION_ERROR", "Allocation amount must be greater than zero.");
  const payment = await lockPayment(tx, ctx.organizationId, paymentId);
  if (payment.status !== "CONFIRMED") throw new AppError("INVALID_STATE", "Only confirmed payments can be allocated.");
  if (!payment.subscriberId) throw new AppError("INVALID_STATE", "Match this payment to a subscriber before allocating it.");
  const available = unallocatedOf(payment);
  if (amount.gt(available)) throw new AppError("INVALID_STATE", `Only ${available.toFixed(2)} ${payment.currency} of this payment is unallocated.`);

  const invoice = await lockInvoice(tx, ctx.organizationId, invoiceId);
  if (invoice.subscriberId !== payment.subscriberId) throw new AppError("INVALID_STATE", "The invoice belongs to a different subscriber.");
  if (invoice.currency !== payment.currency) throw new AppError("INVALID_STATE", "Payment and invoice currencies differ.");
  if (invoice.status !== "OPEN" && invoice.status !== "PARTIALLY_PAID") throw new AppError("INVALID_STATE", `A ${invoice.status.toLowerCase().replace("_", " ")} invoice cannot receive allocations.`);
  if (amount.gt(dec(invoice.balanceDue))) throw new AppError("INVALID_STATE", `The invoice balance is only ${dec(invoice.balanceDue).toFixed(2)} ${invoice.currency}.`);

  const allocation = await tx.paymentAllocation.create({
    data: { organizationId: ctx.organizationId, paymentId, invoiceId, amount: amount.toFixed(2), createdById: actorUserId(ctx) },
  });
  await tx.payment.update({ where: { id: paymentId }, data: { allocatedAmount: dec(payment.allocatedAmount).plus(amount).toFixed(2) } });
  const updated = await adjustInvoiceSettlementTx(tx, invoice, { paid: amount });
  await postLedger(tx, ctx, {
    type: "allocation",
    sourceType: "payment_allocation",
    sourceId: allocation.id,
    description: `Payment ${payment.receiptNumber ?? payment.id} applied to ${invoice.invoiceNumber}`,
    currency: invoice.currency,
    lines: [
      { account: "CUSTOMER_CREDIT", debit: amount, subscriberId: payment.subscriberId },
      { account: "AR", credit: amount, subscriberId: payment.subscriberId },
    ],
  });
  const subscription = updated.status === "PAID" ? await applyPaidInvoiceToSubscriptionTx(tx, ctx, updated) : "none";
  return { allocationId: allocation.id, invoiceId, amount: amount.toFixed(2), invoiceStatus: updated.status, subscription };
}

/** Reverse an allocation: money returns to the customer's credit and the invoice balance reopens. */
export async function reverseAllocationTx(tx: Tx, ctx: ActorContext, allocationId: string, reason: string) {
  const allocation = await tx.paymentAllocation.findFirst({ where: { id: allocationId, organizationId: ctx.organizationId } });
  if (!allocation) throw notFound("allocation");
  const payment = await lockPayment(tx, ctx.organizationId, allocation.paymentId);
  const invoice = await lockInvoice(tx, ctx.organizationId, allocation.invoiceId);
  const fresh = await tx.paymentAllocation.findUniqueOrThrow({ where: { id: allocationId } });
  if (fresh.status !== "ACTIVE") throw new AppError("CONFLICT", "This allocation has already been reversed.");
  const amount = dec(fresh.amount);
  await tx.paymentAllocation.update({ where: { id: allocationId }, data: { status: "REVERSED", reversedAt: new Date(), reversalReason: reason } });
  await tx.payment.update({ where: { id: payment.id }, data: { allocatedAmount: dec(payment.allocatedAmount).minus(amount).toFixed(2) } });
  const updated = await adjustInvoiceSettlementTx(tx, invoice, { paid: amount.neg() });
  await postLedger(tx, ctx, {
    type: "allocation.reversed",
    sourceType: "payment_allocation",
    sourceId: allocationId,
    description: `Allocation to ${invoice.invoiceNumber} reversed: ${reason}`,
    currency: invoice.currency,
    lines: [
      { account: "AR", debit: amount, subscriberId: invoice.subscriberId },
      { account: "CUSTOMER_CREDIT", credit: amount, subscriberId: invoice.subscriberId },
    ],
  });
  return { allocationId, invoiceId: invoice.id, invoiceStatus: updated.status, amount: amount.toFixed(2) };
}

/**
 * Apply all of a subscriber's unallocated confirmed payments to their open invoices,
 * oldest payment to oldest-due invoice. Used after a payment arrives and after an invoice is issued.
 */
export async function autoAllocateForSubscriberTx(tx: Tx, ctx: ActorContext, subscriberId: string, onlyPaymentId?: string): Promise<AllocationResult[]> {
  const payments = await tx.payment.findMany({
    where: { organizationId: ctx.organizationId, subscriberId, status: "CONFIRMED", ...(onlyPaymentId ? { id: onlyPaymentId } : {}) },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
  });
  const results: AllocationResult[] = [];
  for (const p of payments) {
    let available = unallocatedOf(p);
    if (available.lte(0)) continue;
    const invoices = await tx.invoice.findMany({
      where: { organizationId: ctx.organizationId, subscriberId, status: { in: ["OPEN", "PARTIALLY_PAID"] }, currency: p.currency },
      orderBy: [{ dueAt: "asc" }, { issuedAt: "asc" }],
      select: { id: true, balanceDue: true },
    });
    const plan = allocateInOrder(available, invoices.map((i) => ({ id: i.id, balanceDue: dec(i.balanceDue) })));
    for (const step of plan) {
      results.push(await allocateTx(tx, ctx, p.id, step.invoiceId, step.amount));
      available = available.minus(step.amount);
    }
  }
  return results;
}
