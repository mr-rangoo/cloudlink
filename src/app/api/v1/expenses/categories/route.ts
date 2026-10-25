import { staffRoute } from "@/server/api/handler";
import { categoryInput, createExpenseCategory, listExpenseCategories } from "@/server/services/finance";

export const GET = staffRoute({ permission: "expenses.read" }, async ({ ctx }) => ({ data: await listExpenseCategories(ctx) }));
export const POST = staffRoute({ permission: "expenses.write", body: categoryInput }, async ({ ctx, body }) => ({ data: await createExpenseCategory(ctx, body), status: 201 }));
