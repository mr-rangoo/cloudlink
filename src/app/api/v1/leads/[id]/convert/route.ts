import { staffRoute, uuidParam } from "@/server/api/handler";
import { convertLead, leadConvertInput } from "@/server/services/leads";

/** Convert a lead to a subscriber (and optional subscription) atomically. Safe to retry with an Idempotency-Key. */
export const POST = staffRoute({ permission: ["leads.write", "subscribers.write"], params: uuidParam, body: leadConvertInput }, async ({ ctx, params, body }) => ({
  data: await convertLead(ctx, params.id, body),
  status: 201,
}));
