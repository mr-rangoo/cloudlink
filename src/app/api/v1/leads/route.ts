import { paginated, staffRoute } from "@/server/api/handler";
import { createLead, leadInput, leadListQuery, listLeads } from "@/server/services/leads";

export const GET = staffRoute({ permission: "leads.read", query: leadListQuery }, async ({ ctx, query }) => {
  const { rows, total, stageCounts } = await listLeads(ctx, query);
  return { ...paginated(rows, total, query), stageCounts };
});

export const POST = staffRoute({ permission: "leads.write", body: leadInput }, async ({ ctx, body }) => ({ data: await createLead(ctx, body), status: 201 }));
