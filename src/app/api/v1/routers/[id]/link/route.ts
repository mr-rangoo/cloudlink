import { staffRoute, uuidParam } from "@/server/api/handler";
import { getRouterLink } from "@/server/services/router-link";

/** Link wizard state: check-ins, reported ports, saved services and the latest change (polled while waiting). */
export const GET = staffRoute({ permission: "routers.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getRouterLink(ctx, params.id) }));
