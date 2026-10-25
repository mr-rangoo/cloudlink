import { paginated, staffRoute } from "@/server/api/handler";
import { listNetworkOperations, operationListQuery } from "@/server/services/network";

export const GET = staffRoute({ permission: "network.read", query: operationListQuery }, async ({ ctx, query }) => {
  const { rows, total, counts } = await listNetworkOperations(ctx, query);
  return { ...paginated(rows, total, query), counts };
});
