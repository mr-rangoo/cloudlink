import { staffRoute, uuidParam } from "@/server/api/handler";
import { recordRemittance, remittanceInput } from "@/server/services/vouchers";

/** Cash handed in by an agent; cannot exceed the amount owed. */
export const POST = staffRoute({ permission: "payments.record", params: uuidParam, body: remittanceInput, requireIdempotencyKey: true }, async ({ ctx, params, body }) => ({ data: await recordRemittance(ctx, params.id, body), status: 201 }));
