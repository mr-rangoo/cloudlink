import { paginated, staffRoute } from "@/server/api/handler";
import { expenseInput, financeListQuery, listExpenses, recordExpense } from "@/server/services/finance";

export const GET = staffRoute({ permission: "expenses.read", query: financeListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listExpenses(ctx, query);
  return paginated(rows, total, query);
});

export const POST = staffRoute({ permission: "expenses.write", body: expenseInput, requireIdempotencyKey: true }, async ({ ctx, body }) => ({ data: await recordExpense(ctx, body), status: 201 }));
