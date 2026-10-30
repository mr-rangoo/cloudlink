import { staffRoute, uuidParam } from "@/server/api/handler";
import { routerSnapshots } from "@/server/services/router-insights";

/** Latest fetched router logs and diagnosis (request new ones with POST /routers/:id/operations). */
export const GET = staffRoute({ permission: "network.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await routerSnapshots(ctx, params.id) }));
