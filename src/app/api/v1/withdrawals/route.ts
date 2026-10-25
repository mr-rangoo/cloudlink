import { paginated, staffRoute } from "@/server/api/handler";
import { financeListQuery, listWithdrawals, recordWithdrawal, withdrawalInput } from "@/server/services/finance";

export const GET = staffRoute({ permission: "expenses.read", query: financeListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listWithdrawals(ctx, query);
  return paginated(rows, total, query);
});

export const POST = staffRoute({ permission: "expenses.write", body: withdrawalInput, requireIdempotencyKey: true }, async ({ ctx, body }) => ({ data: await recordWithdrawal(ctx, body), status: 201 }));
