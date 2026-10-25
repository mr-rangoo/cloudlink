import { staffRoute, uuidParam } from "@/server/api/handler";
import { getLead, leadUpdate, updateLead } from "@/server/services/leads";

export const GET = staffRoute({ permission: "leads.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getLead(ctx, params.id) }));

export const PATCH = staffRoute({ permission: "leads.write", params: uuidParam, body: leadUpdate }, async ({ ctx, params, body }) => ({
  data: await updateLead(ctx, params.id, body),
}));
