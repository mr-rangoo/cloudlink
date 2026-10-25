import { paginated, staffRoute } from "@/server/api/handler";
import { listPayments, paymentListQuery } from "@/server/services/payments";

/** Confirmed payments not yet matched to a subscriber (for authorized review). */
export const GET = staffRoute({ permission: "payments.reconcile", query: paymentListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listPayments(ctx, { ...query, unmatched: "1", status: "ALL" });
  return paginated(rows, total, query);
});
