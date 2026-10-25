import { paginated, staffRoute } from "@/server/api/handler";
import { listNetworkSessions, requestSessionRefresh, sessionListQuery } from "@/server/services/network";

export const GET = staffRoute({ permission: "network.read", query: sessionListQuery }, async ({ ctx, query }) => {
  const { rows, total, lastSyncedAt, adapter } = await listNetworkSessions(ctx, query);
  return { ...paginated(rows, total, query), lastSyncedAt, adapter };
});

/** Queue a session sync from every router (at most one per 30 seconds per organization). */
export const POST = staffRoute({ permission: "network.read" }, async ({ ctx }) => ({ data: await requestSessionRefresh(ctx), status: 202 }));
