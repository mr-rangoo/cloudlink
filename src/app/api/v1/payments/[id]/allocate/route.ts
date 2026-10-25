import { staffRoute, uuidParam } from "@/server/api/handler";
import { allocateInput, allocatePayment } from "@/server/services/payments";

export const POST = staffRoute({ permission: "payments.allocate", params: uuidParam, body: allocateInput, requireIdempotencyKey: true }, async ({ ctx, params, body }) => ({
  data: await allocatePayment(ctx, params.id, body),
}));
