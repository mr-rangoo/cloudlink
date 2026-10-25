import { staffRoute, uuidParam } from "@/server/api/handler";
import { getTicket, ticketUpdateInput, updateTicket } from "@/server/services/tickets";

export const GET = staffRoute({ permission: "support.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getTicket(ctx, params.id) }));

export const PATCH = staffRoute({ permission: "support.write", params: uuidParam, body: ticketUpdateInput }, async ({ ctx, params, body }) => ({ data: await updateTicket(ctx, params.id, body) }));
