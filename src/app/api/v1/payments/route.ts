import { paginated, staffRoute } from "@/server/api/handler";
import { listPayments, paymentListQuery } from "@/server/services/payments";

export const GET = staffRoute({ permission: "payments.read", query: paymentListQuery }, async ({ ctx, query }) => {
  const { rows, total, confirmedTotal } = await listPayments(ctx, query);
  return { ...paginated(rows, total, query), confirmedTotal };
});
