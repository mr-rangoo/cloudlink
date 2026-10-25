import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { systemContext, type StaffContext } from "@/server/auth/context";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { applySubscriptionAction } from "@/server/services/subscriptions";
import { createCreditNote, createManualInvoice, getInvoice, invoiceCreateInput, issueInvoice, runRecurringBilling, voidInvoice, deleteDraftInvoice } from "@/server/services/invoices";
import { allocatePayment, manualPaymentInput, recordManualPayment, reconcilePayment, refundPayment, reverseAllocation, reversePayment } from "@/server/services/payments";
import { runReconciliationChecks } from "@/server/services/finance";
import { subscriberLedgerBalance, trialBalance } from "@/server/services/ledger";
import { invoicePdf, receiptPdf } from "@/server/services/documents";
import { POST as manualPaymentRoute } from "@/app/api/v1/payments/manual/route";
import { contextFor, createOrg, createStaff, request, sessionFor } from "./fixtures";

const pay = (o: Record<string, unknown>) => manualPaymentInput.parse({ method: "CASH", receivedAt: new Date(Date.now() - 60_000).toISOString(), ...o });
let phoneSeq = 0;
const nextPhone = () => `07${String(10_000_000 + phoneSeq++).padStart(8, "0")}`;

async function setup(opts: { price?: string; taxRate?: string; activate?: boolean } = {}) {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, { name: "Home 10", serviceType: "PPPOE", price: opts.price ?? "2500.00", taxRate: opts.taxRate ?? "0", billingUnit: "MONTH", billingCount: 1, description: null });
  const { subscriber, subscription } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Jane", phone: nextPhone(), packageId: pkg.id, activateSubscription: opts.activate ?? true }));
  return { org, ctx, pkg, subscriber, subscription };
}

async function invoicesOf(subscriberId: string) {
  return db.invoice.findMany({ where: { subscriberId }, orderBy: { createdAt: "asc" } });
}

async function expectBooksClean(ctx: StaffContext) {
  const checks = await runReconciliationChecks(ctx);
  expect(checks.invoiceCacheMismatches).toEqual([]);
  expect(checks.paymentCacheMismatches).toEqual([]);
  expect(checks.receivables.matches).toBe(true);
  expect(checks.ledgerBalanced).toBe(true);
}

describe("invoices", () => {
  it("issues an activation invoice with a gapless number, frozen lines and a balanced ledger posting", async () => {
    const { ctx, subscriber, subscription } = await setup({ price: "2500.00", taxRate: "16" });
    const [inv] = await invoicesOf(subscriber.id);
    expect(inv).toMatchObject({ status: "OPEN", invoiceNumber: "INV-000001", source: "activation", subscriptionId: subscription!.id });
    expect(inv!.total.toString()).toBe("2900");
    expect(inv!.taxTotal.toString()).toBe("400");
    expect(inv!.billingPeriodStart?.getTime()).toBe(subscription!.currentPeriodStart?.getTime());
    expect((await getInvoice(ctx, inv!.id)).overdue).toBe(false); // due at the end of the local day, not the issue instant
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.accounts.find((a) => a.code === "1100")?.balance).toBe("2900.00");
    expect(tb.accounts.find((a) => a.code === "2200")?.balance).toBe("-400.00");

    // Database-level immutability of issued invoices and ledger rows.
    const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv!.id } });
    await expect(db.invoiceLine.update({ where: { id: line.id }, data: { unitPrice: "1" } })).rejects.toThrow();
    await expect(db.invoice.update({ where: { id: inv!.id }, data: { total: "1" } })).rejects.toThrow();
    await expect(db.invoice.delete({ where: { id: inv!.id } })).rejects.toThrow();
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { organizationId: ctx.organizationId } });
    await expect(db.ledgerEntry.update({ where: { id: entry.id }, data: { debit: "1" } })).rejects.toThrow();
    await expect(db.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
  });

  it("rejects an unbalanced ledger transaction at the database level", async () => {
    const { ctx } = await setup();
    const account = await db.ledgerAccount.findFirstOrThrow({ where: { organizationId: ctx.organizationId, code: "1000" } });
    await expect(
      db.$transaction(async (tx) => {
        const t = await tx.ledgerTransaction.create({ data: { organizationId: ctx.organizationId, type: "test", sourceType: "test", sourceId: ctx.organizationId, description: "x", currency: "KES", occurredAt: new Date(), actorType: "user" } });
        await tx.ledgerEntry.create({ data: { organizationId: ctx.organizationId, transactionId: t.id, accountId: account.id, debit: "10" } });
      }),
    ).rejects.toThrow(/unbalanced|two entries/);
  });

  it("creates manual draft invoices, issues them later, and deletes only drafts", async () => {
    const { ctx, subscriber } = await setup({ activate: false });
    const draft = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: subscriber.id, issue: false, lines: [{ description: "Router", quantity: "1", unitPrice: "3500", taxRate: "16" }, { description: "Installation", quantity: "1", unitPrice: "1000", discount: "250" }] }));
    expect(draft.status).toBe("DRAFT");
    expect(draft.invoiceNumber).toBeNull();
    expect(draft.total.toString()).toBe("4810");
    const issued = await issueInvoice(ctx, draft.id);
    expect(issued.invoiceNumber).toMatch(/^INV-\d{6}$/);
    await expect(issueInvoice(ctx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(deleteDraftInvoice(ctx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const other = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: subscriber.id, issue: false, lines: [{ description: "x", quantity: "1", unitPrice: "1" }] }));
    await deleteDraftInvoice(ctx, other.id);
    expect(await db.invoice.count({ where: { id: other.id } })).toBe(0);
  });

  it("voids an unpaid invoice with a reversing ledger entry, but refuses invoices with payments", async () => {
    const { ctx, subscriber } = await setup();
    const [inv] = await invoicesOf(subscriber.id);
    await voidInvoice(ctx, inv!.id, "Created in error");
    expect((await db.invoice.findUniqueOrThrow({ where: { id: inv!.id } })).status).toBe("VOID");
    await expect(voidInvoice(ctx, inv!.id, "again")).rejects.toMatchObject({ code: "CONFLICT" });
    await expectBooksClean(ctx);

    const s2 = await setup();
    const [inv2] = await invoicesOf(s2.subscriber.id);
    await recordManualPayment(s2.ctx, pay({ subscriberId: s2.subscriber.id, amount: "100" }));
    await expect(voidInvoice(s2.ctx, inv2!.id, "x")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("recurring billing", () => {
  it("invoices the next period once, even when run repeatedly and concurrently", async () => {
    const { org, subscription, subscriber } = await setup();
    const sys = systemContext(org.organization.id, "worker:billing", "test");
    // Not yet due (period ends in ~a month, lead time 3 days).
    expect((await runRecurringBilling(sys)).created).toBe(0);
    // Move to 2 days before period end.
    const end = subscription!.currentPeriodEnd!;
    const now = new Date(end.getTime() - 2 * 86_400_000);
    const results = await Promise.allSettled([runRecurringBilling(sys, now), runRecurringBilling(sys, now), runRecurringBilling(sys, now)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const all = await invoicesOf(subscriber.id);
    expect(all.map((i) => i.source)).toEqual(["activation", "recurring"]);
    const next = all[1]!;
    expect(next.billingPeriodStart?.getTime()).toBe(end.getTime());
    expect(next.generationKey).toBe(`sub:${subscription!.id}:${end.toISOString()}`);
    expect((await runRecurringBilling(sys, now)).created).toBe(0);
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } });
    expect(sub.invoicedThrough?.getTime()).toBe(next.billingPeriodEnd?.getTime());
  });

  it("does not bill suspended, cancelled or non-auto-renew subscriptions", async () => {
    const { org, ctx, subscription, subscriber } = await setup();
    await applySubscriptionAction(ctx, subscription!.id, "suspend", { reason: "test" });
    const sys = systemContext(org.organization.id, "worker:billing", "test");
    expect((await runRecurringBilling(sys, new Date(subscription!.currentPeriodEnd!.getTime() - 86_400_000))).created).toBe(0);
    expect(await db.invoice.count({ where: { subscriberId: subscriber.id } })).toBe(1);
  });
});

describe("payments and allocation", () => {
  it("records partial then full payments, updates balances and renews the subscription exactly once", async () => {
    const { org, ctx, subscription, subscriber } = await setup();
    const sys = systemContext(org.organization.id, "worker:billing", "test");
    // Pay the activation invoice in two parts.
    const p1 = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "1000" }));
    let [act] = await invoicesOf(subscriber.id);
    expect(act!.status).toBe("PARTIALLY_PAID");
    expect(act!.balanceDue.toString()).toBe("1500");
    expect(p1.payment.receiptNumber).toBe("RCT-000001");
    await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "1500" }));
    [act] = await invoicesOf(subscriber.id);
    expect(act!.status).toBe("PAID");
    // Activation invoice covers the current period → no renewal.
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } })).periodIndex).toBe(0);

    // Next period invoice, then payment → renewal continues seamlessly.
    await runRecurringBilling(sys, new Date(subscription!.currentPeriodEnd!.getTime() - 86_400_000));
    const res = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "2500", method: "BANK_TRANSFER", reference: "FT123ABC" }));
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0]!.subscription).toBe("renewed");
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } });
    expect(sub.periodIndex).toBe(1);
    expect(sub.currentPeriodStart?.getTime()).toBe(subscription!.currentPeriodEnd?.getTime());
    expect(await db.subscriptionEvent.count({ where: { subscriptionId: subscription!.id, type: "renewed" } })).toBe(1);

    // Same bank reference cannot be recorded twice.
    await expect(recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "10", method: "BANK_TRANSFER", reference: "ft123abc" }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expectBooksClean(ctx);
    const bal = await subscriberLedgerBalance(db, ctx.organizationId, subscriber.id);
    expect(bal.net.toFixed(2)).toBe("0.00");
  });

  it("restarts an expired subscription from the payment date when its outstanding invoice is paid late", async () => {
    const { org, ctx, subscription, subscriber } = await setup();
    const sys = systemContext(org.organization.id, "worker:billing", "test");
    await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "2500" })); // activation invoice paid
    await runRecurringBilling(sys, new Date(subscription!.currentPeriodEnd!.getTime() - 86_400_000)); // next period invoiced
    await db.subscription.update({ where: { id: subscription!.id }, data: { status: "EXPIRED", currentPeriodStart: new Date(Date.now() - 40 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000) } });
    const before = Date.now();
    const res = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "2500" }));
    expect(res.allocations[0]!.subscription).toBe("renewed");
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: subscription!.id } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.periodIndex).toBe(0); // restarted with a new anchor
    expect(sub.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    await expectBooksClean(ctx);
  });

  it("keeps overpayments as customer credit and applies them to the next issued invoice", async () => {
    const { ctx, subscriber } = await setup({ activate: false });
    const res = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "5000" }));
    expect(res.allocations).toEqual([]);
    expect((await subscriberLedgerBalance(db, ctx.organizationId, subscriber.id)).credit.toFixed(2)).toBe("5000.00");
    const inv = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: subscriber.id, lines: [{ description: "Service", quantity: "1", unitPrice: "3000" }] }));
    const after = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe("PAID");
    const bal = await subscriberLedgerBalance(db, ctx.organizationId, subscriber.id);
    expect(bal.credit.toFixed(2)).toBe("2000.00");
    expect(bal.net.toFixed(2)).toBe("-2000.00");
    await expectBooksClean(ctx);
  });

  it("enforces allocation limits, subscriber match and concurrency safety", async () => {
    const { ctx, subscriber } = await setup({ activate: false });
    const other = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Other", phone: nextPhone() }));
    const invA = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: subscriber.id, lines: [{ description: "A", quantity: "1", unitPrice: "1000" }] }));
    const invB = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: subscriber.id, lines: [{ description: "B", quantity: "1", unitPrice: "1000" }] }));
    const invOther = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: other.subscriber.id, lines: [{ description: "O", quantity: "1", unitPrice: "1000" }] }));
    const { payment } = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "1200", autoAllocate: false }));

    await expect(allocatePayment(ctx, payment.id, { allocations: [{ invoiceId: invA.id, amount: "1300" }] })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(allocatePayment(ctx, payment.id, { allocations: [{ invoiceId: invOther.id, amount: "100" }] })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await allocatePayment(ctx, payment.id, { allocations: [{ invoiceId: invA.id, amount: "1000" }] });
    await expect(allocatePayment(ctx, payment.id, { allocations: [{ invoiceId: invA.id, amount: "1" }] })).rejects.toMatchObject({ code: "INVALID_STATE" }); // invoice already paid

    // Two concurrent allocations of the remaining 200 cannot both succeed.
    const results = await Promise.allSettled([
      allocatePayment(ctx, payment.id, { allocations: [{ invoiceId: invB.id, amount: "150" }] }),
      allocatePayment(ctx, payment.id, { allocations: [{ invoiceId: invB.id, amount: "150" }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const p = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(p.allocatedAmount.toString()).toBe("1150");
    await expectBooksClean(ctx);
  });

  it("is idempotent over HTTP: the same Idempotency-Key records one payment", async () => {
    const { org, subscriber } = await setup();
    const token = await sessionFor(org.owner.id, org.organization.id);
    const body = { subscriberId: subscriber.id, amount: "500", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() };
    const call = () => manualPaymentRoute(request("/api/v1/payments/manual", { body, token, headers: { "idempotency-key": "pay-key-000001" } }), { params: Promise.resolve({}) });
    const [a, b] = [await call(), await call()];
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(await db.payment.count({ where: { subscriberId: subscriber.id } })).toBe(1);
    const noKey = await manualPaymentRoute(request("/api/v1/payments/manual", { body, token }), { params: Promise.resolve({}) });
    expect(noKey.status).toBe(400);
  });

  it("validates payment input", () => {
    expect(manualPaymentInput.safeParse({ subscriberId: null, amount: "0", method: "CASH", receivedAt: new Date().toISOString() }).success).toBe(false);
    expect(manualPaymentInput.safeParse({ amount: "100", method: "BANK_TRANSFER", receivedAt: new Date().toISOString() }).success).toBe(false); // reference required
    expect(manualPaymentInput.safeParse({ amount: "100", method: "CASH", receivedAt: new Date(Date.now() + 86_400_000).toISOString() }).success).toBe(false);
  });
});

describe("corrections: credit notes, refunds, reversals", () => {
  it("credits an open invoice, then credits a paid invoice into customer credit, within the creditable cap", async () => {
    const { ctx, subscriber } = await setup({ price: "2000.00", taxRate: "16" }); // total 2320
    const [inv] = await invoicesOf(subscriber.id);
    const cn1 = await createCreditNote(ctx, inv!.id, { amount: "1160", reason: "Outage compensation" });
    expect(cn1).toMatchObject({ creditNoteNumber: "CRN-000001" });
    expect(cn1.taxTotal.toString()).toBe("160");
    let after = await db.invoice.findUniqueOrThrow({ where: { id: inv!.id } });
    expect(after.balanceDue.toString()).toBe("1160");
    await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "1160" }));
    after = await db.invoice.findUniqueOrThrow({ where: { id: inv!.id } });
    expect(after.status).toBe("PAID");
    const cn2 = await createCreditNote(ctx, inv!.id, { amount: "500", reason: "Goodwill" });
    expect(cn2.toCustomerCredit.toString()).toBe("500");
    await expect(createCreditNote(ctx, inv!.id, { amount: "700", reason: "Too much" })).rejects.toMatchObject({ code: "INVALID_STATE" }); // only 660 left
    expect((await subscriberLedgerBalance(db, ctx.organizationId, subscriber.id)).credit.toFixed(2)).toBe("500.00");
    await expect(db.creditNote.update({ where: { id: cn1.id }, data: { reason: "x" } })).rejects.toThrow(); // append-only
    await expectBooksClean(ctx);
  });

  it("refunds only unallocated money; allocations must be reversed first", async () => {
    const { ctx, subscriber } = await setup(); // invoice 2500
    const { payment } = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "3000" })); // 2500 allocated, 500 credit
    await expect(refundPayment(ctx, payment.id, { amount: "600", method: "CASH", reason: "Overpaid" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await refundPayment(ctx, payment.id, { amount: "500", method: "CASH", reason: "Overpaid" });
    const alloc = await db.paymentAllocation.findFirstOrThrow({ where: { paymentId: payment.id } });
    await reverseAllocation(ctx, payment.id, alloc.id, "Wrong invoice");
    const [inv] = await invoicesOf(subscriber.id);
    expect(inv!.status).toBe("OPEN");
    expect(inv!.balanceDue.toString()).toBe("2500");
    await expect(reverseAllocation(ctx, payment.id, alloc.id, "again")).rejects.toMatchObject({ code: "CONFLICT" });
    await refundPayment(ctx, payment.id, { amount: "2500", method: "MPESA", reason: "Customer cancelled" });
    const p = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(p.refundedAmount.toString()).toBe("3000");
    await expectBooksClean(ctx);
  });

  it("reverses a payment: allocations undone, invoice reopened, reference freed for a corrected entry", async () => {
    const { ctx, subscriber } = await setup();
    const { payment } = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "2500", method: "CHEQUE", reference: "CHQ-0042" }));
    expect((await invoicesOf(subscriber.id))[0]!.status).toBe("PAID");
    await reversePayment(ctx, payment.id, "Cheque bounced");
    expect((await invoicesOf(subscriber.id))[0]!.status).toBe("OPEN");
    await expect(reversePayment(ctx, payment.id, "again")).rejects.toMatchObject({ code: "CONFLICT" });
    await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "2500", method: "CHEQUE", reference: "CHQ-0042" }));
    expect((await invoicesOf(subscriber.id))[0]!.status).toBe("PAID");
    await expectBooksClean(ctx);
  });

  it("restricts refunds and reversals to authorised roles", async () => {
    const { org, ctx, subscriber } = await setup();
    const { payment } = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "3000" }));
    const { user } = await createStaff(org.organization.id, "cashier");
    const cashier = await contextFor(user.id, org.organization.id);
    await expect(refundPayment(cashier, payment.id, { amount: "100", method: "CASH", reason: "x-x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reversePayment(cashier, payment.id, "nope")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createCreditNote(cashier, (await invoicesOf(subscriber.id))[0]!.id, { amount: "1", reason: "nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // ...but a cashier can record payments.
    await expect(recordManualPayment(cashier, pay({ subscriberId: subscriber.id, amount: "1" }))).resolves.toBeTruthy();
  });
});

describe("reconciliation", () => {
  it("matches unidentified receipts to a subscriber and allocates them", async () => {
    const { ctx, subscriber } = await setup();
    const { payment } = await recordManualPayment(ctx, pay({ subscriberId: null, amount: "2500", method: "BANK_TRANSFER", reference: "UNKNOWN-1", payerName: "J WANJ" }));
    expect(payment.subscriberId).toBeNull();
    await expect(allocatePayment(ctx, payment.id, { allocations: [{ invoiceId: (await invoicesOf(subscriber.id))[0]!.id, amount: "1" }] })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const res = await reconcilePayment(ctx, payment.id, { subscriberId: subscriber.id, autoAllocate: true });
    expect(res.allocations).toHaveLength(1);
    expect((await invoicesOf(subscriber.id))[0]!.status).toBe("PAID");
    await expect(reconcilePayment(ctx, payment.id, { subscriberId: subscriber.id, autoAllocate: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.reconciliationRecord.count({ where: { paymentId: payment.id, action: "matched" } })).toBe(1);
    await expectBooksClean(ctx);
  });

  it("detects a tampered cached balance", async () => {
    const { ctx, subscriber } = await setup();
    await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "1000" }));
    const pmt = await db.payment.findFirstOrThrow({ where: { subscriberId: subscriber.id } });
    await db.payment.update({ where: { id: pmt.id }, data: { allocatedAmount: "900" } }); // simulate corruption
    const checks = await runReconciliationChecks(ctx);
    expect(checks.ok).toBe(false);
    expect(checks.paymentCacheMismatches).toHaveLength(1);
  });

  it("isolates organizations", async () => {
    const a = await setup();
    const b = await setup();
    const [invA] = await invoicesOf(a.subscriber.id);
    await expect(getInvoice(b.ctx, invA!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { payment } = await recordManualPayment(b.ctx, pay({ subscriberId: b.subscriber.id, amount: "10" }));
    await expect(allocatePayment(a.ctx, payment.id, { allocations: [{ invoiceId: invA!.id, amount: "10" }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(recordManualPayment(b.ctx, pay({ subscriberId: a.subscriber.id, amount: "10" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("documents", () => {
  it("renders invoice and receipt PDFs from persisted records", async () => {
    const { ctx, subscriber } = await setup({ taxRate: "16" });
    const { payment } = await recordManualPayment(ctx, pay({ subscriberId: subscriber.id, amount: "1000" }));
    const [inv] = await invoicesOf(subscriber.id);
    const a = await invoicePdf(ctx, inv!.id);
    const b = await receiptPdf(ctx, payment.id);
    expect(a.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(a.filename).toBe("INV-000001.pdf");
    expect(b.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(b.pdf.length).toBeGreaterThan(1000);
  });
});
