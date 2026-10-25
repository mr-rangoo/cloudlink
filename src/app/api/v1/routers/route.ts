import { paginated, staffRoute } from "@/server/api/handler";
import { createRouter, listRouters, routerInput, routerListQuery } from "@/server/services/routers";

export const GET = staffRoute({ permission: "routers.read", query: routerListQuery }, async ({ ctx, query }) => {
  const { rows, total, adapter } = await listRouters(ctx, query);
  return { ...paginated(rows, total, query), adapter };
});

/** Register a router. Credentials are write-only: they are encrypted and never returned. */
export const POST = staffRoute({ permission: "routers.write", body: routerInput }, async ({ ctx, body }) => ({ data: await createRouter(ctx, body), status: 201 }));
