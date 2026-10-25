import { staffRoute, uuidParam } from "@/server/api/handler";
import { requestRouterOperation, routerOperationInput } from "@/server/services/network";

/**
 * Request an allowlisted operation on a router: `pppoe.sync` (re-apply a subscription's current access state) or
 * `session.disconnect`. Arbitrary router commands are not accepted. The operation runs in the worker; poll
 * GET /network/operations/:id for the real outcome.
 */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam, body: routerOperationInput }, async ({ ctx, params, body }) => ({
  data: await requestRouterOperation(ctx, params.id, body),
  status: 202,
}));
