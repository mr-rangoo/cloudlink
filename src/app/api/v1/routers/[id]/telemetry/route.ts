import { staffRoute, uuidParam } from "@/server/api/handler";
import { routerTelemetry, telemetryQuery } from "@/server/services/router-insights";

/** Health score, chart series, reachability heatmap and outages from the router's health-check samples. */
export const GET = staffRoute({ permission: "routers.read", params: uuidParam, query: telemetryQuery }, async ({ ctx, params, query }) => ({ data: await routerTelemetry(ctx, params.id, query) }));
