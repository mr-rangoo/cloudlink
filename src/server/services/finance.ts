import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { listWhere, requirePermission, resolveBranchForCreate, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { D, positiveMoneyInput } from "@/server/domain/money";
import { fromWallTime, toWallTime } from "@/server/domain/time";
import { actorUserId } from "@/server/services/common";
import { accountBalance, cashAccountFor, computeTrialBalance, postLedger } from "@/server/services/ledger";
import type { Prisma } from "@/generated/prisma/client";

const dec = (v: { toString(): string }) => new D(v.toString());
const METHODS = ["CASH", "BANK_TRANSFER", "MPESA", "CHEQUE", "CARD", "OTHER"] as const;
export const DEFAULT_EXPENSE_CATEGORIES = ["Bandwidth / upstream", "Equipment", "Salaries", "Rent", "Power / fuel", "Transport", "Licences and fees", "Other"];

export const expenseInput = z.object({
  categoryId: z.uuid(),
  amount: positiveMoneyInput,
  method: z.enum(METHODS),
  paidAt: z.coerce.date(),
  payee: z.string().trim().max(120).optional().nullable(),
  reference: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().min(2).max(500),
  branchId: z.uuid().optional().nullable(),
});

export const withdrawalInput = z.object({
  amount: positiveMoneyInput,
  fromMethod: z.enum(METHODS),
  kind: z.enum(["OWNER_DRAWING", "BANK_DEPOSIT"]),
  occurredAt: z.coerce.date(),
  reference: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().min(2).max(500),
  branchId: z.uuid().optional().nullable(),
});

export const categoryInput = z.object({ name: z.string().trim().min(2).max(80) });
export const reverseExpenseInput = z.object({ reason: z.string().trim().min(3).max(500) });
export const financeListQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });

export async function listExpenseCategories(ctx: ActorContext) {
  requirePermission(ctx, "expenses.read");
  const existing = await db.expenseCategory.count({ where: { organizationId: ctx.organizationId } });
  if (existing === 0) {
    await db.expenseCategory.createMany({ data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ organizationId: ctx.organizationId, name })), skipDuplicates: true });
  }
  return db.expenseCategory.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, orderBy: { name: "asc" } });
}

export async function createExpenseCategory(ctx: ActorContext, input: z.infer<typeof categoryInput>) {
  requirePermission(ctx, "expenses.write");
  const c = await db.expenseCategory.create({ data: { organizationId: ctx.organizationId, name: input.name } });
  await audit(ctx, { action: "expense_category.create", entityType: "expense_category", entityId: c.id, metadata: { name: c.name } });
  return c;
}

export async function recordExpense(ctx: ActorContext, input: z.infer<typeof expenseInput>) {
  requirePermission(ctx, "expenses.write");
  if (input.paidAt.getTime() > Date.now() + 5 * 60_000) throw new AppError("VALIDATION_ERROR", "The payment date cannot be in the future.", { fields: [{ path: "paidAt", message: "Future date" }] });
  const branchId = await resolveBranchForCreate(ctx, input.branchId);
  const expense = await db.$transaction(async (tx) => {
    const category = await tx.expenseCategory.findFirst({ where: { id: input.categoryId, organizationId: ctx.organizationId } });
    if (!category) throw notFound("expense category");
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
    const e = await tx.expense.create({
      data: { organizationId: ctx.organizationId, branchId, categoryId: category.id, amount: input.amount, currency: org.currency, method: input.method, paidAt: input.paidAt, payee: input.payee ?? null, reference: input.reference ?? null, description: input.description, createdById: actorUserId(ctx) },
    });
    await postLedger(tx, ctx, {
      type: "expense",
      sourceType: "expense",
      sourceId: e.id,
      description: `${category.name}: ${input.description}`,
      currency: org.currency,
      occurredAt: input.paidAt,
      lines: [
        { account: "EXPENSES", debit: new D(input.amount) },
        { account: cashAccountFor(input.method), credit: new D(input.amount) },
      ],
    });
    return e;
  });
  await audit(ctx, { action: "expense.record", entityType: "expense", entityId: expense.id, metadata: { amount: expense.amount.toString(), categoryId: expense.categoryId } });
  return expense;
}

export async function reverseExpense(ctx: ActorContext, id: string, reason: string) {
  requirePermission(ctx, "expenses.write");
  const result = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Expense" WHERE "id" = ${id}::uuid AND "organizationId" = ${ctx.organizationId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound("expense");
    const e = await tx.expense.findUniqueOrThrow({ where: { id } });
    if (e.status === "REVERSED") throw new AppError("CONFLICT", "This expense is already reversed.");
    await postLedger(tx, ctx, {
      type: "expense.reversed",
      sourceType: "expense",
      sourceId: id,
      description: `Expense reversed: ${reason}`,
      currency: e.currency,
      lines: [
        { account: cashAccountFor(e.method), debit: dec(e.amount) },
        { account: "EXPENSES", credit: dec(e.amount) },
      ],
    });
    return tx.expense.update({ where: { id }, data: { status: "REVERSED", reversedAt: new Date(), reversalReason: reason } });
  });
  await audit(ctx, { action: "expense.reverse", entityType: "expense", entityId: id, metadata: { reason } });
  return result;
}

export async function listExpenses(ctx: ActorContext, query: z.infer<typeof financeListQuery>) {
  requirePermission(ctx, "expenses.read");
  const where: Prisma.ExpenseWhereInput = { ...listWhere(ctx) };
  const [rows, total, categories] = await Promise.all([
    db.expense.findMany({ where, orderBy: { paidAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.expense.count({ where }),
    db.expenseCategory.findMany({ where: { organizationId: ctx.organizationId } }),
  ]);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  return { rows: rows.map((r) => ({ ...r, categoryName: names.get(r.categoryId) ?? "—" })), total };
}

/** Owner drawing (money taken out of the business) or bank deposit (cash/M-Pesa moved to the bank). */
export async function recordWithdrawal(ctx: ActorContext, input: z.infer<typeof withdrawalInput>) {
  requirePermission(ctx, "expenses.write");
  if (input.kind === "BANK_DEPOSIT" && cashAccountFor(input.fromMethod) === "BANK") {
    throw new AppError("VALIDATION_ERROR", "A bank deposit must come from cash or M-Pesa.", { fields: [{ path: "fromMethod", message: "Choose cash or M-Pesa" }] });
  }
  const branchId = await resolveBranchForCreate(ctx, input.branchId);
  const w = await db.$transaction(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
    const source = cashAccountFor(input.fromMethod);
    const available = await accountBalance(tx, ctx.organizationId, source);
    if (new D(input.amount).gt(available)) {
      throw new AppError("INVALID_STATE", `The ${source.toLowerCase().replace("_", " ")} account only holds ${available.toFixed(2)} ${org.currency} according to the ledger.`);
    }
    const row = await tx.withdrawal.create({
      data: { organizationId: ctx.organizationId, branchId, amount: input.amount, currency: org.currency, fromMethod: input.fromMethod, kind: input.kind, occurredAt: input.occurredAt, reference: input.reference ?? null, description: input.description, createdById: actorUserId(ctx) },
    });
    await postLedger(tx, ctx, {
      type: input.kind === "OWNER_DRAWING" ? "withdrawal" : "bank_deposit",
      sourceType: "withdrawal",
      sourceId: row.id,
      description: input.description,
      currency: org.currency,
      occurredAt: input.occurredAt,
      lines: [
        { account: input.kind === "OWNER_DRAWING" ? "OWNER_DRAWINGS" : "BANK", debit: new D(input.amount) },
        { account: source, credit: new D(input.amount) },
      ],
    });
    return row;
  });
  await audit(ctx, { action: `withdrawal.${input.kind.toLowerCase()}`, entityType: "withdrawal", entityId: w.id, metadata: { amount: w.amount.toString(), from: input.fromMethod } });
  return w;
}

export async function listWithdrawals(ctx: ActorContext, query: z.infer<typeof financeListQuery>) {
  requirePermission(ctx, "expenses.read");
  const where: Prisma.WithdrawalWhereInput = { ...listWhere(ctx) };
  const [rows, total] = await Promise.all([db.withdrawal.findMany({ where, orderBy: { occurredAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }), db.withdrawal.count({ where })]);
  return { rows, total };
}

/**
 * Collections summary for a calendar month (organization timezone): confirmed receipts by method, refunds,
 * expenses, and current ledger balances of the cash-type accounts.
 */
export async function collectionsSummary(ctx: ActorContext & { organization: { timezone: string } }, month?: string) {
  requirePermission(ctx, "expenses.read");
  const tz = ctx.organization.timezone;
  const now = toWallTime(new Date(), tz);
  const [y, m] = month && /^\d{4}-\d{2}$/.test(month) ? month.split("-").map(Number) as [number, number] : [now.year, now.month];
  const start = fromWallTime({ year: y, month: m, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
  const end = fromWallTime({ year: m === 12 ? y + 1 : y, month: m === 12 ? 1 : m + 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, tz);
  const scope = listWhere(ctx);
  const [byMethod, refunds, expenses, drawings, balances] = await Promise.all([
    db.payment.groupBy({ by: ["method"], where: { ...scope, status: "CONFIRMED", receivedAt: { gte: start, lt: end } }, _sum: { amount: true }, _count: { _all: true } }),
    db.refund.aggregate({ where: { organizationId: ctx.organizationId, refundedAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    db.expense.aggregate({ where: { ...scope, status: "RECORDED", paidAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    db.withdrawal.aggregate({ where: { ...scope, kind: "OWNER_DRAWING", occurredAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    Promise.all((["CASH", "BANK", "MPESA", "OTHER_RECEIPTS"] as const).map(async (a) => ({ account: a, balance: (await accountBalance(db, ctx.organizationId, a)).toFixed(2) }))),
  ]);
  const collected = byMethod.reduce((acc, r) => acc.plus(dec(r._sum.amount ?? 0)), new D(0));
  return {
    month: `${y}-${String(m).padStart(2, "0")}`,
    byMethod: byMethod.map((r) => ({ method: r.method, count: r._count._all, amount: dec(r._sum.amount ?? 0).toFixed(2) })),
    collected: collected.toFixed(2),
    refunds: dec(refunds._sum.amount ?? 0).toFixed(2),
    expenses: dec(expenses._sum.amount ?? 0).toFixed(2),
    ownerDrawings: dec(drawings._sum.amount ?? 0).toFixed(2),
    net: collected.minus(dec(refunds._sum.amount ?? 0)).minus(dec(expenses._sum.amount ?? 0)).toFixed(2),
    ledgerBalances: balances,
  };
}

/**
 * Reconciliation checks: recompute every cached settlement figure from the underlying records and compare,
 * and verify the ledger. Cached balances are never trusted blindly.
 */
export async function runReconciliationChecks(ctx: ActorContext) {
  requirePermission(ctx, "payments.reconcile");
  const org = ctx.organizationId;
  const invoiceMismatches = await db.$queryRaw<Array<{ id: string; invoiceNumber: string | null; cached_paid: string; actual_paid: string; cached_credited: string; actual_credited: string }>>`
    SELECT i."id", i."invoiceNumber",
      i."amountPaid"::text AS cached_paid, COALESCE(a.paid, 0)::text AS actual_paid,
      i."amountCredited"::text AS cached_credited, COALESCE(c.credited, 0)::text AS actual_credited
    FROM "Invoice" i
    LEFT JOIN (SELECT "invoiceId", SUM("amount") AS paid FROM "PaymentAllocation" WHERE "status" = 'ACTIVE' GROUP BY "invoiceId") a ON a."invoiceId" = i."id"
    LEFT JOIN (SELECT "invoiceId", SUM("appliedToInvoice") AS credited FROM "CreditNote" GROUP BY "invoiceId") c ON c."invoiceId" = i."id"
    WHERE i."organizationId" = ${org}::uuid
      AND (i."amountPaid" <> COALESCE(a.paid, 0) OR i."amountCredited" <> COALESCE(c.credited, 0))
    LIMIT 100`;
  const paymentMismatches = await db.$queryRaw<Array<{ id: string; receiptNumber: string | null; cached_allocated: string; actual_allocated: string; cached_refunded: string; actual_refunded: string }>>`
    SELECT p."id", p."receiptNumber",
      p."allocatedAmount"::text AS cached_allocated, COALESCE(a.allocated, 0)::text AS actual_allocated,
      p."refundedAmount"::text AS cached_refunded, COALESCE(r.refunded, 0)::text AS actual_refunded
    FROM "Payment" p
    LEFT JOIN (SELECT "paymentId", SUM("amount") AS allocated FROM "PaymentAllocation" WHERE "status" = 'ACTIVE' GROUP BY "paymentId") a ON a."paymentId" = p."id"
    LEFT JOIN (SELECT "paymentId", SUM("amount") AS refunded FROM "Refund" GROUP BY "paymentId") r ON r."paymentId" = p."id"
    WHERE p."organizationId" = ${org}::uuid
      AND (p."allocatedAmount" <> COALESCE(a.allocated, 0) OR p."refundedAmount" <> COALESCE(r.refunded, 0))
    LIMIT 100`;
  const [arRow] = await db.$queryRaw<Array<{ open: string }>>`
    SELECT COALESCE(SUM("balanceDue"), 0)::text AS open FROM "Invoice" WHERE "organizationId" = ${org}::uuid AND "status" IN ('OPEN', 'PARTIALLY_PAID')`;
  const arLedger = await accountBalance(db, org, "AR");
  const tb = await computeTrialBalance(org);
  const unmatched = await db.payment.aggregate({ where: { organizationId: org, status: "CONFIRMED", subscriberId: null }, _sum: { amount: true }, _count: { _all: true } });

  const result = {
    checkedAt: new Date().toISOString(),
    invoiceCacheMismatches: invoiceMismatches,
    paymentCacheMismatches: paymentMismatches,
    receivables: { invoices: new D(arRow?.open ?? "0").toFixed(2), ledger: arLedger.toFixed(2), matches: new D(arRow?.open ?? "0").eq(arLedger) },
    ledgerBalanced: tb.balanced,
    unmatchedPayments: { count: unmatched._count._all, amount: dec(unmatched._sum.amount ?? 0).toFixed(2) },
  };
  const ok = !invoiceMismatches.length && !paymentMismatches.length && result.receivables.matches && result.ledgerBalanced;
  await db.reconciliationRecord.create({
    data: { organizationId: org, action: "balance_check", outcome: ok ? "ok" : "mismatch", details: JSON.parse(JSON.stringify(result)), actorUserId: actorUserId(ctx) },
  });
  return { ...result, ok };
}
