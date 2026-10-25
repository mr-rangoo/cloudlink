import { staffRoute } from "@/server/api/handler";
import { agentInput, createAgent, listAgents } from "@/server/services/vouchers";

export const GET = staffRoute({ permission: "vouchers.read" }, async ({ ctx }) => ({ data: await listAgents(ctx) }));
export const POST = staffRoute({ permission: "vouchers.write", body: agentInput }, async ({ ctx, body }) => ({ data: await createAgent(ctx, body), status: 201 }));
