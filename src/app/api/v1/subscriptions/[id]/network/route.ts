import { staffRoute, uuidParam } from "@/server/api/handler";
import { provisionInput, provisionSubscriptionNetwork, subscriptionNetwork } from "@/server/services/network";

/** Network access for a subscription: router, PPPoE username, network status (separate from billing status). */
export const GET = staffRoute({ permission: "network.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await subscriptionNetwork(ctx, params.id) }));

/** Provision (or move / re-provision) PPPoE access. Queues a durable network operation. */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam, body: provisionInput }, async ({ ctx, params, body }) => ({
  data: await provisionSubscriptionNetwork(ctx, params.id, body),
  status: 202,
}));
