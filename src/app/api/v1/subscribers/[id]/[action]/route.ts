import { z } from "zod";
import { staffRoute } from "@/server/api/handler";
import { AppError } from "@/server/errors";
import { resolveSubscriberSubscription } from "@/server/services/subscribers";
import { applySubscriptionAction } from "@/server/services/subscriptions";

/**
 * Subscriber-level lifecycle shortcuts: POST /subscribers/:id/{renew|suspend|reactivate}.
 * They act on `subscriptionId` (or the subscriber's only non-cancelled subscription).
 * Renewal requires an Idempotency-Key so retries cannot extend service twice.
 */
const params = z.object({ id: z.uuid(), action: z.enum(["renew", "suspend", "reactivate"]) });
const body = z.object({ subscriptionId: z.uuid().optional(), reason: z.string().trim().max(500).optional() });

export const POST = staffRoute({ permission: "subscriptions.write", params, body }, async ({ ctx, params, body, idempotencyKey }) => {
  if (params.action === "renew" && !idempotencyKey) {
    throw new AppError("VALIDATION_ERROR", "An Idempotency-Key header is required to renew.");
  }
  const subscriptionId = await resolveSubscriberSubscription(ctx, params.id, body.subscriptionId);
  const sub = await applySubscriptionAction(ctx, subscriptionId, params.action, {
    reason: body.reason,
    idempotencyKey: idempotencyKey ? `api:${idempotencyKey}` : undefined,
  });
  return { data: sub };
});
