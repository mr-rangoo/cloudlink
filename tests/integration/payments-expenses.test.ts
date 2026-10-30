import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { listPayments, manualPaymentInput, paymentPeriodSummary, recordManualPayment } from "@/server/services/payments";
import { expenseInput, expenseSummary, listExpenseCategories, listExpenses, recordExpense, reverseExpense } from "@/server/services/finance";
import { dateRange, downloadExport, requestExport } from "@/server/services/exports";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { addLocalDays, localDateKey, startOfLocalDay } from "@/server/domain/time";
import { contextFor, createOrg, createStaff } from "./fixtures";

let phoneSeq = 0;
const nextPhone = () => `07${String(63_000_000 + phoneSeq++).padStart(8, "0")}`;
const TZ = "Africa/Nairobi";
const DAY = 86_400_000;

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, { name: "Fibre 10", serviceType: "PPPOE", price: "2000.00", taxRate: "0", billingUnit: "MONTH", billingCount: 1, description: null });
  const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Akinyi", phone: nextPhone(), packageId: pkg.id, activateSubscription: true }));
  return { org, ctx, subscriber };
}

async function runAllOps() {
  for (const op of await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED"] } } })) await runOperation(op.id, operationHandlers);
}

describe("payments by period", () => {
  it("filters by period, method and type, and summarises collected, unmatched and credit", async () => {
    const { ctx, subscriber } = await setup();
    const today = startOfLocalDay(new Date(), TZ);
    const at = (daysAgo: number) => new Date(Math.min(Date.now() - 1000, addLocalDays(today, -daysAgo, TZ).getTime() + 3_600_000));
    const pay = (o: Record<string, unknown>) => recordManualPayment(ctx, manualPaymentInput.parse({ method: "CASH", ...o }));
    await pay({ subscriberId: subscriber.id, amount: "2000", receivedAt: at(0).toISOString() }); // pays the invoice
    await pay({ subscriberId: subscriber.id, amount: "500", receivedAt: at(0).toISOString() }); // credit on the account
    await pay({ subscriberId: subscriber.id, amount: "300", method: "MPESA", reference: "QAB1234567", receivedAt: at(3).toISOString() });
    await pay({ subscriberId: null, amount: "250", method: "BANK_TRANSFER", reference: "BNK-9", receivedAt: at(5).toISOString() });
    await pay({ subscriberId: subscriber.id, amount: "900", receivedAt: at(40).toISOString() });

    expect((await listPayments(ctx, { period: "today" })).total).toBe(2);
    expect((await listPayments(ctx, { period: "7d" })).total).toBe(4);
    expect((await listPayments(ctx, { period: "30d", method: "MPESA" })).total).toBe(1);
    expect((await listPayments(ctx, { type: "manual" })).total).toBe(5);
    expect((await listPayments(ctx, { type: "stk" })).total).toBe(0);
    const day = localDateKey(at(3), TZ);
    expect((await listPayments(ctx, { period: "custom", from: day, to: day })).rows.map((r) => r.amount.toString())).toEqual(["300"]);

    const rows = (await listPayments(ctx, { period: "today" })).rows;
    expect(rows.map((r) => r.reconciliation).sort()).toEqual(["allocated", "credit"]);
    expect(rows.every((r) => r.source === "manual" && r.activation === null)).toBe(true);

    const week = await paymentPeriodSummary(ctx, { period: "7d" });
    expect(week).toMatchObject({ currency: "KES", collected: "3050.00", payments: 4, unmatched: { amount: "250.00", payments: 1 }, creditOnAccounts: "800.00" });
    expect(week.byMethod).toEqual([
      { method: "CASH", amount: "2500.00", payments: 2 },
      { method: "MPESA", amount: "300.00", payments: 1 },
      { method: "BANK_TRANSFER", amount: "250.00", payments: 1 },
    ]);
    expect(week.bySource).toEqual([{ source: "manual", amount: "3050.00", payments: 4 }]);
    expect((await paymentPeriodSummary(ctx, {})).collected).toBe("3950.00");
  });

  it("keeps period figures within branch scope and permissions", async () => {
    const { org, ctx, subscriber } = await setup();
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: subscriber.id, amount: "700", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    const branch = await db.branch.create({ data: { organizationId: org.organization.id, name: "Kisumu", code: "KSM" } });
    const scoped = await createStaff(org.organization.id, "cashier", { branchIds: [branch.id] });
    expect((await paymentPeriodSummary(await contextFor(scoped.user.id, org.organization.id), { period: "today" })).collected).toBe("0.00");
    const sales = await createStaff(org.organization.id, "sales");
    await expect(paymentPeriodSummary(await contextFor(sales.user.id, org.organization.id), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("expenses by period", () => {
  it("summarises spending by category against the previous period and collections", async () => {
    const { ctx, subscriber } = await setup();
    const [bandwidth, rent] = await listExpenseCategories(ctx);
    const spend = (categoryId: string, amount: string, daysAgo: number, description = "Expense") =>
      recordExpense(ctx, expenseInput.parse({ categoryId, amount, method: "MPESA", paidAt: new Date(Date.now() - daysAgo * DAY - 1000).toISOString(), description }));
    await spend(bandwidth!.id, "1200", 1, "Upstream link");
    await spend(rent!.id, "800", 2, "Office rent");
    const reversed = await spend(rent!.id, "999", 2, "Mistake");
    await reverseExpense(ctx, reversed.id, "Entered twice");
    await spend(bandwidth!.id, "600", 10, "Older upstream");
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: subscriber.id, amount: "3000", method: "CASH", receivedAt: new Date(Date.now() - DAY).toISOString() }));

    const s = await expenseSummary(ctx, { period: "7d" });
    expect(s).toMatchObject({ spent: "2000.00", entries: 2, collected: "3000.00", net: "1000.00", previous: { spent: "600.00" } });
    expect(s.byCategory.map((c) => [c.name, c.amount])).toEqual([
      [bandwidth!.name, "1200.00"],
      [rent!.name, "800.00"],
    ]);
    expect((await listExpenses(ctx, { period: "7d" })).total).toBe(3); // includes the reversed entry
    expect((await listExpenses(ctx, { period: "7d", status: "REVERSED" })).total).toBe(1);
    expect((await listExpenses(ctx, { categoryId: bandwidth!.id })).total).toBe(2);
    expect((await listExpenses(ctx, { q: "office" })).total).toBe(1);

    // Expenses need their own permission; other organizations see nothing.
    const sales = await createStaff(ctx.organizationId, "sales");
    await expect(expenseSummary(await contextFor(sales.user.id, ctx.organizationId), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await createOrg("Other ISP");
    expect((await expenseSummary(await contextFor(other.owner.id, other.organization.id), {})).spent).toBe("0.00");
  });
});

describe("exports", () => {
  it("use local dates with real month ends", () => {
    expect(dateRange({ from: "2026-02", to: "2026-02" }, TZ)).toEqual({ gte: new Date("2026-01-31T21:00:00.000Z"), lt: new Date("2026-02-28T21:00:00.000Z") });
    expect(dateRange({ to: "2026-12" }, TZ)).toEqual({ lt: new Date("2026-12-31T21:00:00.000Z") });
    expect(dateRange({ from: "2026-03-31", to: "2026-03-31" }, TZ)).toEqual({ gte: new Date("2026-03-30T21:00:00.000Z"), lt: new Date("2026-03-31T21:00:00.000Z") });
  });

  it("export payments with the page's filters, and expenses", async () => {
    const { ctx, subscriber } = await setup();
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: subscriber.id, amount: "400", method: "MPESA", reference: "QZZ7654321", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: subscriber.id, amount: "150", method: "CASH", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    const [cat] = await listExpenseCategories(ctx);
    await recordExpense(ctx, expenseInput.parse({ categoryId: cat!.id, amount: "75", method: "CASH", paidAt: new Date(Date.now() - 1000).toISOString(), description: "Cable ties", payee: "=cmd" }));

    const job = await requestExport(ctx, { type: "payments", params: { method: "MPESA" } });
    const exp = await requestExport(ctx, { type: "expenses", params: {} });
    await runAllOps();
    const payments = (await downloadExport(ctx, job.id)).data.toString("utf8");
    expect(payments).toContain("receipt_number,received_at,account_number,subscriber,payer_name,type,method");
    expect(payments).toContain("QZZ7654321");
    expect(payments).not.toContain(",CASH,");
    const expenses = (await downloadExport(ctx, exp.id)).data.toString("utf8");
    expect(expenses).toContain("paid_at,category,description,payee");
    expect(expenses).toContain("Cable ties");
    expect(expenses).toContain("'=cmd"); // formula neutralised
    const support = await createStaff((await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } })).id, "support");
    await expect(requestExport(await contextFor(support.user.id, ctx.organizationId), { type: "expenses", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
