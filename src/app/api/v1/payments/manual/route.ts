import { staffRoute } from "@/server/api/handler";
import { manualPaymentInput, recordManualPayment } from "@/server/services/payments";

/** Record a confirmed cash/bank/cheque/manual M-Pesa payment. Requires an Idempotency-Key. */
export const POST = staffRoute({ permission: "payments.record", body: manualPaymentInput, requireIdempotencyKey: true }, async ({ ctx, body }) => ({
  data: await recordManualPayment(ctx, body),
  status: 201,
}));
