import { staffRoute } from "@/server/api/handler";
import { listGateways } from "@/server/services/payment-gateways";

/** Gateway catalogue with configuration status and which one collects online payments (no secrets). */
export const GET = staffRoute({ permission: "integrations.read" }, async ({ ctx }) => ({ data: await listGateways(ctx) }));
