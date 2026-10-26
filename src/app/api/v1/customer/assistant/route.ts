import { customerRoute } from "@/server/api/handler";
import { customerAssistant } from "@/server/assistant/service";

/** Whether the assistant is available, its name, and the customer's open chat (visible messages only). */
export const GET = customerRoute({}, async ({ ctx }) => ({ data: await customerAssistant(ctx) }));
