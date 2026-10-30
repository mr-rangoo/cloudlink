import { staffRoute, uuidParam } from "@/server/api/handler";
import { routerReport } from "@/server/services/router-insights";

/** Router reports: collections (payments.read only), sessions over 30 days, peak hours, subscriptions by status. */
export const GET = staffRoute({ permission: "routers.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await routerReport(ctx, params.id) }));
