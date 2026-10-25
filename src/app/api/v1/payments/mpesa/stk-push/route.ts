import { staffRoute } from "@/server/api/handler";
import { initiateStkPush, stkPushInput } from "@/server/services/mobile-money";

/**
 * Prompt a subscriber's phone to pay (M-Pesa STK Push). Requires an Idempotency-Key. Returns the payment request;
 * money is recorded only when M-Pesa confirms it by callback. Poll GET /payments/attempts/:id for the outcome.
 */
export const POST = staffRoute({ permission: "payments.initiate", body: stkPushInput, requireIdempotencyKey: true }, async ({ ctx, body, idempotencyKey }) => ({
  data: await initiateStkPush(ctx, body, { channel: "staff", idempotencyKey: idempotencyKey! }),
  status: 202,
}));
