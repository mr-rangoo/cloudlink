import { staffRoute, uuidParam } from "@/server/api/handler";
import { agentUpdateInput, updateAgent } from "@/server/services/vouchers";

export const PATCH = staffRoute({ permission: "vouchers.write", params: uuidParam, body: agentUpdateInput }, async ({ ctx, params, body }) => ({ data: await updateAgent(ctx, params.id, body) }));
