import { paginated, staffRoute } from "@/server/api/handler";
import { attemptListQuery, listAttempts } from "@/server/services/mobile-money";

/** M-Pesa payment requests and their outcomes. */
export const GET = staffRoute({ permission: "payments.read", query: attemptListQuery }, async ({ ctx, query }) => {
  const { rows, total, counts } = await listAttempts(ctx, query);
  return { ...paginated(rows, total, query), counts };
});
