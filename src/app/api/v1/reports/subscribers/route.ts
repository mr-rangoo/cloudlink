import { staffRoute } from "@/server/api/handler";
import { reportRangeQuery, subscriberReport } from "@/server/services/reports";

export const GET = staffRoute({ permission: "reports.read", query: reportRangeQuery }, async ({ ctx, query }) => ({ data: await subscriberReport(ctx, query) }));
