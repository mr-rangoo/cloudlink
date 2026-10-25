import { paginated, staffRoute, uuidParam } from "@/server/api/handler";
import { listNetworkSessions, sessionListQuery } from "@/server/services/network";

export const GET = staffRoute({ permission: "network.read", params: uuidParam, query: sessionListQuery.omit({ routerId: true }) }, async ({ ctx, params, query }) => {
  const { rows, total, lastSyncedAt, adapter } = await listNetworkSessions(ctx, { ...query, routerId: params.id });
  return { ...paginated(rows, total, query), lastSyncedAt, adapter };
});
