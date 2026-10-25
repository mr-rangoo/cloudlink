import { staffRoute, uuidParam } from "@/server/api/handler";
import { requestHealthCheck } from "@/server/services/routers";

/** Queue a reachability check; the worker contacts the router and records the result on the router. */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam }, async ({ ctx, params }) => ({ data: await requestHealthCheck(ctx, params.id), status: 202 }));
