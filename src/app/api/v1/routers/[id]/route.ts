import { staffRoute, uuidParam } from "@/server/api/handler";
import { getRouter, routerUpdateInput, updateRouter } from "@/server/services/routers";

export const GET = staffRoute({ permission: "routers.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getRouter(ctx, params.id) }));

/** Edit a router. Send both `username` and `password` to rotate the API credentials. */
export const PATCH = staffRoute({ permission: "routers.write", params: uuidParam, body: routerUpdateInput }, async ({ ctx, params, body }) => ({ data: await updateRouter(ctx, params.id, body) }));
