import { staffRoute, uuidParam } from "@/server/api/handler";
import { addLeadActivity, leadActivityInput } from "@/server/services/leads";

export const POST = staffRoute({ permission: "leads.write", params: uuidParam, body: leadActivityInput }, async ({ ctx, params, body }) => ({
  data: await addLeadActivity(ctx, params.id, body),
  status: 201,
}));
