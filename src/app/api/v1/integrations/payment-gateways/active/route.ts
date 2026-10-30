import { staffRoute } from "@/server/api/handler";
import { activeGatewayInput, setActiveGateway } from "@/server/services/payment-gateways";

/** Choose the gateway for new online payments (it must be configured). Requests already sent are unaffected. */
export const PUT = staffRoute({ permission: "integrations.write", body: activeGatewayInput }, async ({ ctx, body }) => ({ data: await setActiveGateway(ctx, body) }));
