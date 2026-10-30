import { staffRoute, uuidParam } from "@/server/api/handler";
import { AppError } from "@/server/errors";
import { compensateInput, compensateSubscription } from "@/server/services/subscriptions";

/**
 * POST /subscriptions/:id/compensate — add free time (hours or days, with a reason) to the paid period.
 * Requires an Idempotency-Key so a retried request never adds the time twice.
 */
export const POST = staffRoute({ permission: "subscriptions.write", params: uuidParam, body: compensateInput }, async ({ ctx, params, body, idempotencyKey }) => {
  if (!idempotencyKey) throw new AppError("VALIDATION_ERROR", "An Idempotency-Key header is required to compensate.");
  return { data: await compensateSubscription(ctx, params.id, body) };
});
