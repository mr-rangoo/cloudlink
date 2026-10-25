import { customerRoute, uuidParam } from "@/server/api/handler";
import { getCustomerAttempt } from "@/server/services/mobile-money";

/** Status of the customer's own payment request (other customers' requests are not found). */
export const GET = customerRoute({ params: uuidParam }, async ({ ctx, params }) => ({ data: await getCustomerAttempt(ctx, params.id) }));
