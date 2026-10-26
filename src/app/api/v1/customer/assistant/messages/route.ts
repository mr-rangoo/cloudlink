import { customerRoute } from "@/server/api/handler";
import { assistantMessageInput, sendAssistantMessage } from "@/server/assistant/service";

/** Send a message to the assistant; returns the new visible messages (rate-limited per customer and organization). */
export const POST = customerRoute({ body: assistantMessageInput }, async ({ ctx, body }) => ({ data: await sendAssistantMessage(ctx, body) }));
