import { customerRoute, uuidParam } from "@/server/api/handler";
import { getCustomerTicket } from "@/server/services/tickets";

export const GET = customerRoute({ params: uuidParam }, async ({ ctx, params }) => ({ data: await getCustomerTicket(ctx, params.id) }));
