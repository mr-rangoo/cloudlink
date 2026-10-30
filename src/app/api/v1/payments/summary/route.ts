import { staffRoute } from "@/server/api/handler";
import { paymentListQuery, paymentPeriodSummary } from "@/server/services/payments";

/** Payment figures for a period: collected, by method and by how the money arrived, unmatched, credit, reversals. */
export const GET = staffRoute({ permission: "payments.read", query: paymentListQuery }, async ({ ctx, query }) => ({ data: await paymentPeriodSummary(ctx, query) }));
