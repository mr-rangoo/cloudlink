import { staffRoute, uuidParam } from "@/server/api/handler";
import { archiveRouter } from "@/server/services/routers";

/** Archive a router (refused while subscriptions are still provisioned on it). */
export const POST = staffRoute({ permission: "routers.write", params: uuidParam }, async ({ ctx, params }) => ({ data: await archiveRouter(ctx, params.id) }));
