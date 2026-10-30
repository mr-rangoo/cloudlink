import { staffRoute } from "@/server/api/handler";
import { expenseListQuery, expenseSummary } from "@/server/services/finance";

/** Spending for a period by category, the previous period, and (with payments.read) collections and the difference. */
export const GET = staffRoute({ permission: "expenses.read", query: expenseListQuery }, async ({ ctx, query }) => ({ data: await expenseSummary(ctx, query) }));
