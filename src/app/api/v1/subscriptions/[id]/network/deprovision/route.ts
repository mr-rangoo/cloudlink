import { staffRoute, uuidParam } from "@/server/api/handler";
import { deprovisionInput, deprovisionSubscriptionNetwork } from "@/server/services/network";

/** Remove network access: queues removal of the router/RADIUS account and clears the stored credentials. */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam, body: deprovisionInput }, async ({ ctx, params, body }) => ({
  data: await deprovisionSubscriptionNetwork(ctx, params.id, body),
  status: 202,
}));
