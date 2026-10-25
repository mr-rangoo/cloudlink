import { staffRoute, uuidParam } from "@/server/api/handler";
import { getAttempt } from "@/server/services/mobile-money";

/** One payment request with its provider callbacks (minimised) and resulting payment. */
export const GET = staffRoute({ permission: "payments.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getAttempt(ctx, params.id) }));
