import { z } from "zod";
import { staffRoute } from "@/server/api/handler";
import { AppError } from "@/server/errors";
import { applySubscriptionAction, subscriptionActionInput } from "@/server/services/subscriptions";

/**
 * POST /subscriptions/:id/{activate|renew|suspend|reactivate|cancel}
 * Renewal requires an Idempotency-Key; the key is also recorded on the subscription event,
 * so a retried renewal never extends the paid period twice.
 */
const params = z.object({ id: z.uuid(), action: z.enum(["activate", "renew", "suspend", "reactivate", "cancel"]) });

export const POST = staffRoute({ permission: "subscriptions.write", params, body: subscriptionActionInput }, async ({ ctx, params, body, idempotencyKey }) => {
  if (params.action === "renew" && !idempotencyKey) throw new AppError("VALIDATION_ERROR", "An Idempotency-Key header is required to renew.");
  if (params.action === "suspend" && !body.reason) throw new AppError("VALIDATION_ERROR", "Give a reason for the suspension.", { fields: [{ path: "reason", message: "Required" }] });
  const sub = await applySubscriptionAction(ctx, params.id, params.action, {
    reason: body.reason,
    idempotencyKey: idempotencyKey ? `api:${idempotencyKey}` : undefined,
    invoice: body.invoice,
  });
  return { data: sub };
});
