import { staffRoute } from "@/server/api/handler";
import { collectionsReport, reportRangeQuery } from "@/server/services/reports";

export const GET = staffRoute({ permission: "reports.read", query: reportRangeQuery }, async ({ ctx, query }) => ({ data: await collectionsReport(ctx, query) }));
