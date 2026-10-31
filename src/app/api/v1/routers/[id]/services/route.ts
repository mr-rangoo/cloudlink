import { staffRoute, uuidParam } from "@/server/api/handler";
import { servicesInput } from "@/server/domain/router-agent";
import { saveRouterServices } from "@/server/services/router-link";

/** Link a MikroTik, step 3: hotspot and/or PPPoE, ports and limits. Applied by the router on its next check-in. */
export const PUT = staffRoute({ permission: "routers.write", params: uuidParam, body: servicesInput }, async ({ ctx, params, body }) => ({ data: await saveRouterServices(ctx, params.id, body) }));
