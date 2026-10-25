import { staffRoute, uuidParam } from "@/server/api/handler";
import { reverseExpense, reverseExpenseInput } from "@/server/services/finance";

export const POST = staffRoute({ permission: "expenses.write", params: uuidParam, body: reverseExpenseInput }, async ({ ctx, params, body }) => ({ data: await reverseExpense(ctx, params.id, body.reason) }));
