import { staffRoute, uuidParam } from "@/server/api/handler";
import { getAssistantConversation } from "@/server/assistant/service";

/** Transcript of one customer chat, including which tools the assistant used. */
export const GET = staffRoute({ permission: "support.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getAssistantConversation(ctx, params.id) }));
