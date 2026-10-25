import { paginated, staffRoute } from "@/server/api/handler";
import { alertListQuery, listRouterAlerts } from "@/server/services/routers";

export const GET = staffRoute({ permission: "network.read", query: alertListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listRouterAlerts(ctx, query);
  return paginated(rows, total, query);
});
