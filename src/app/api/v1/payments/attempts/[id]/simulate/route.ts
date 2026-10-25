import { staffRoute, uuidParam } from "@/server/api/handler";
import { simulateInput, simulateMockResponse } from "@/server/services/mobile-money";

/** Development only (mock adapter; refused in production): play the customer's response through the callback pipeline. */
export const POST = staffRoute({ permission: "payments.initiate", params: uuidParam, body: simulateInput }, async ({ ctx, params, body }) => ({ data: await simulateMockResponse(ctx, params.id, body) }));
