import { customerRoute } from "@/server/api/handler";
import { endAssistantConversation } from "@/server/assistant/service";

/** End the open chat; the next message starts a new one. */
export const POST = customerRoute({}, async ({ ctx }) => ({ data: await endAssistantConversation(ctx) }));
