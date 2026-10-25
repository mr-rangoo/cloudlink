import { staffRoute } from "@/server/api/handler";
import { reportRangeQuery, revenueReport } from "@/server/services/reports";

export const GET = staffRoute({ permission: "reports.read", query: reportRangeQuery }, async ({ ctx, query }) => ({ data: await revenueReport(ctx, query) }));
