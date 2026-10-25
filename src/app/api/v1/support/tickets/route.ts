import { paginated, staffRoute } from "@/server/api/handler";
import { createTicket, listTickets, staffTicketInput, ticketListQuery } from "@/server/services/tickets";

export const GET = staffRoute({ permission: "support.read", query: ticketListQuery }, async ({ ctx, query }) => {
  const { rows, total, statusCounts } = await listTickets(ctx, query);
  return { ...paginated(rows, total, query), statusCounts };
});

export const POST = staffRoute({ permission: "support.write", body: staffTicketInput }, async ({ ctx, body }) => ({ data: await createTicket(ctx, body), status: 201 }));
