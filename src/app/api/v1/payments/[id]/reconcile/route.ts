import { staffRoute, uuidParam } from "@/server/api/handler";
import { reconcileInput, reconcilePayment } from "@/server/services/payments";

/** Match an unidentified payment to a subscriber (and optionally allocate it). */
export const POST = staffRoute({ permission: "payments.reconcile", params: uuidParam, body: reconcileInput }, async ({ ctx, params, body }) => ({
  data: await reconcilePayment(ctx, params.id, body),
}));
