import "server-only";
import { db } from "@/server/db/client";
import type { CustomerContext } from "@/server/auth/context";
import { notFound } from "@/server/errors";
import { subscriberLedgerBalance } from "@/server/services/ledger";
import { getBillingSettings } from "@/server/services/invoices";
import { unallocatedOf } from "@/server/services/settlement";
import { activePaymentInstructions } from "@/server/services/payment-methods";
import { renderInvoicePdf, renderReceiptPdf } from "@/server/documents/pdf";
import { lastSessionSync } from "@/server/services/network";

/**
 * Customer-portal reads. Every query is scoped by the subscriber bound to the customer session —
 * never by an id supplied in the request — so one customer cannot reach another customer's records.
 */
export async function customerOverview(ctx: CustomerContext) {
  const [subscriber, subscriptions, balance, openInvoices, recentPayments] = await Promise.all([
    db.subscriber.findUniqueOrThrow({ where: { id: ctx.subscriberId }, select: { displayName: true, accountNumber: true, phone: true, email: true, type: true } }),
    db.subscription.findMany({
      where: { subscriberId: ctx.subscriberId, status: { not: "CANCELLED" } },
      select: { id: true, packageName: true, status: true, price: true, currency: true, billingUnit: true, billingCount: true, currentPeriodEnd: true },
      orderBy: { createdAt: "desc" },
    }),
    subscriberLedgerBalance(db, ctx.organizationId, ctx.subscriberId),
    db.invoice.findMany({ where: { subscriberId: ctx.subscriberId, status: { in: ["OPEN", "PARTIALLY_PAID"] } }, orderBy: { dueAt: "asc" }, select: { id: true, invoiceNumber: true, total: true, balanceDue: true, dueAt: true, currency: true } }),
    db.payment.findMany({ where: { subscriberId: ctx.subscriberId, status: { in: ["CONFIRMED", "REVERSED"] } }, orderBy: { receivedAt: "desc" }, take: 5, select: { id: true, receiptNumber: true, amount: true, currency: true, method: true, receivedAt: true, status: true } }),
  ]);
  return { subscriber, subscriptions, balance: { owed: balance.receivable.toFixed(2), credit: balance.credit.toFixed(2), net: balance.net.toFixed(2) }, openInvoices, recentPayments };
}

/** Older than this, a connection status is shown as possibly out of date (sessions sync every few minutes). */
export const CONNECTION_STALE_MS = 15 * 60_000;

/**
 * The customer's own internet connection, from the latest session sync. Never asks the router directly:
 * customers cannot cause router traffic, and the answer says how fresh it is.
 */
export async function customerConnection(ctx: CustomerContext, now = new Date()) {
  const [lines, sessions, lastSync] = await Promise.all([
    db.subscription.count({ where: { organizationId: ctx.organizationId, subscriberId: ctx.subscriberId, status: { not: "CANCELLED" }, networkUsername: { not: null } } }),
    db.networkSession.findMany({
      where: { organizationId: ctx.organizationId, subscriberId: ctx.subscriberId },
      orderBy: [{ endedAt: { sort: "desc", nulls: "first" } }, { lastSeenAt: "desc" }],
      take: 10,
      select: { endedAt: true, startedAt: true, lastSeenAt: true, uptimeSeconds: true, address: true, bytesIn: true, bytesOut: true, source: true },
    }),
    lastSessionSync(ctx.organizationId),
  ]);
  const active = sessions.filter((x) => !x.endedAt);
  const current = active[0];
  const lastEnded = sessions.find((x) => x.endedAt);
  const checkedAt = current?.lastSeenAt ?? lastSync;
  return {
    status: current ? ("ONLINE" as const) : lines ? ("OFFLINE" as const) : ("NOT_SET_UP" as const),
    connections: active.length,
    since: current ? (current.startedAt ?? (current.uptimeSeconds != null ? new Date(current.lastSeenAt.getTime() - current.uptimeSeconds * 1000) : null)) : null,
    address: current?.address ?? null,
    downloadedBytes: current?.bytesOut?.toString() ?? null,
    uploadedBytes: current?.bytesIn?.toString() ?? null,
    lastOnlineAt: current ? null : (lastEnded?.endedAt ?? null),
    checkedAt,
    stale: !checkedAt || now.getTime() - checkedAt.getTime() > CONNECTION_STALE_MS,
    simulated: current ? current.source === "mock" : false,
  };
}

export async function listCustomerInvoices(ctx: CustomerContext) {
  return db.invoice.findMany({
    where: { subscriberId: ctx.subscriberId, organizationId: ctx.organizationId, status: { not: "DRAFT" } },
    orderBy: { issuedAt: "desc" },
    take: 200,
    select: { id: true, invoiceNumber: true, status: true, total: true, balanceDue: true, currency: true, issuedAt: true, dueAt: true, billingPeriodStart: true, billingPeriodEnd: true },
  });
}

export async function getCustomerInvoice(ctx: CustomerContext, id: string) {
  const inv = await db.invoice.findFirst({
    where: { id, subscriberId: ctx.subscriberId, organizationId: ctx.organizationId, status: { not: "DRAFT" } },
    include: { lines: { orderBy: { position: "asc" } }, allocations: { where: { status: "ACTIVE" }, include: { payment: { select: { receiptNumber: true, receivedAt: true, method: true } } } }, creditNotes: { select: { creditNoteNumber: true, total: true, issuedAt: true, reason: true } } },
  });
  if (!inv) throw notFound("invoice");
  return inv;
}

export async function listCustomerPayments(ctx: CustomerContext) {
  const rows = await db.payment.findMany({
    where: { subscriberId: ctx.subscriberId, organizationId: ctx.organizationId, status: { in: ["CONFIRMED", "REVERSED", "PENDING"] } },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  return rows.map((p) => ({ id: p.id, receiptNumber: p.receiptNumber, amount: p.amount, currency: p.currency, method: p.method, status: p.status, receivedAt: p.receivedAt, reference: p.providerTransactionId, unallocated: unallocatedOf(p).toFixed(2) }));
}

async function orgHeader(organizationId: string) {
  const [org, s] = await Promise.all([db.organization.findUniqueOrThrow({ where: { id: organizationId } }), getBillingSettings(db, organizationId)]);
  return { name: org.name, legalName: s.legalName, address: s.address, phone: s.phone, email: s.email, taxPin: s.taxPin, taxLabel: s.taxLabel, footer: s.invoiceFooter, timezone: org.timezone };
}

export async function customerInvoicePdf(ctx: CustomerContext, id: string) {
  const inv = await getCustomerInvoice(ctx, id);
  const sub = await db.subscriber.findUniqueOrThrow({ where: { id: ctx.subscriberId }, select: { displayName: true, accountNumber: true, phone: true, email: true, addresses: { take: 1 } } });
  const a = sub.addresses[0];
  const pdf = await renderInvoicePdf({
    org: await orgHeader(ctx.organizationId),
    invoice: inv,
    subscriber: { ...sub, address: a ? [a.line1, a.area, a.town].filter(Boolean).join(", ") : null },
    howToPay: await activePaymentInstructions(ctx.organizationId, sub.accountNumber),
  });
  return { pdf, filename: `${inv.invoiceNumber}.pdf` };
}

export async function customerReceiptPdf(ctx: CustomerContext, id: string) {
  const p = await db.payment.findFirst({
    where: { id, subscriberId: ctx.subscriberId, organizationId: ctx.organizationId, status: { in: ["CONFIRMED", "REVERSED"] } },
    include: { allocations: { include: { invoice: { select: { invoiceNumber: true } } } } },
  });
  if (!p) throw notFound("receipt");
  const sub = await db.subscriber.findUniqueOrThrow({ where: { id: ctx.subscriberId }, select: { displayName: true, accountNumber: true } });
  const pdf = await renderReceiptPdf({
    org: await orgHeader(ctx.organizationId),
    payment: { ...p, allocations: p.allocations.map((a) => ({ invoiceNumber: a.invoice.invoiceNumber, amount: a.amount, status: a.status })), refunded: p.refundedAmount, unallocated: unallocatedOf(p).toFixed(2) },
    subscriber: sub,
  });
  return { pdf, filename: `${p.receiptNumber ?? "receipt"}.pdf` };
}
