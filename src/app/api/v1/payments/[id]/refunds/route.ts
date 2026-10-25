import { staffRoute, uuidParam } from "@/server/api/handler";
import { refundInput, refundPayment } from "@/server/services/payments";

export const POST = staffRoute({ permission: "payments.refund", params: uuidParam, body: refundInput, requireIdempotencyKey: true }, async ({ ctx, params, body }) => ({
  data: await refundPayment(ctx, params.id, body),
  status: 201,
}));
