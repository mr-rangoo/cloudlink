import { staffRoute } from "@/server/api/handler";
import { linkRouterInput, startRouterLink } from "@/server/services/router-link";

/** Link a MikroTik, step 1: create the router record (no address or credentials yet). */
export const POST = staffRoute({ permission: "routers.write", body: linkRouterInput }, async ({ ctx, body }) => ({ data: await startRouterLink(ctx, body), status: 201 }));
