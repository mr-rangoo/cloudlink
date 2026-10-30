import { staffRoute, uuidParam } from "@/server/api/handler";
import { requestRouterOperation, routerOperationInput } from "@/server/services/network";

/**
 * Request an allowlisted operation on a router: `pppoe.sync` (re-apply a subscription's current access state),
 * `session.disconnect`, `router.diagnose`, `router.logs`, and (with routers.write) `router.reboot`, `router.identity`,
 * `router.clock`, `hotspot.walled_garden`, `hotspot.login_page`. Arbitrary router commands are not accepted. The operation
 * runs in the worker; poll GET /network/operations/:id for the real outcome.
 */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam, body: routerOperationInput }, async ({ ctx, params, body }) => ({
  data: await requestRouterOperation(ctx, params.id, body),
  status: 202,
}));
