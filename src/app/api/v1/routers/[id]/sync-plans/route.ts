import { staffRoute, uuidParam } from "@/server/api/handler";
import { syncRouterPlans } from "@/server/services/packages";

/** Queue a profile push of every plan this router uses. */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam }, async ({ ctx, params }) => ({ data: await syncRouterPlans(ctx, params.id), status: 202 }));
