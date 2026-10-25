import { staffRoute, uuidParam } from "@/server/api/handler";
import { reverseInput, reversePayment } from "@/server/services/payments";

export const POST = staffRoute({ permission: "payments.refund", params: uuidParam, body: reverseInput }, async ({ ctx, params, body }) => ({
  data: await reversePayment(ctx, params.id, body.reason),
}));
