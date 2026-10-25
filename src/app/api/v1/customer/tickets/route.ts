import { customerRoute } from "@/server/api/handler";
import { createCustomerTicket, customerTicketInput, listCustomerTickets } from "@/server/services/tickets";

export const GET = customerRoute({}, async ({ ctx }) => ({ data: await listCustomerTickets(ctx) }));
export const POST = customerRoute({ body: customerTicketInput }, async ({ ctx, body }) => ({ data: await createCustomerTicket(ctx, body), status: 201 }));
