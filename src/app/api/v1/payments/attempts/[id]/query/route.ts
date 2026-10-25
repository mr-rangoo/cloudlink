import { staffRoute, uuidParam } from "@/server/api/handler";
import { requestStatusCheck } from "@/server/services/mobile-money";

/** Ask M-Pesa for the request's current state now (runs in the worker). */
export const POST = staffRoute({ permission: "payments.initiate", params: uuidParam }, async ({ ctx, params }) => ({ data: await requestStatusCheck(ctx, params.id), status: 202 }));
