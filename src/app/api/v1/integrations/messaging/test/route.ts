import { staffRoute } from "@/server/api/handler";
import { sendTestMessage, testMessageInput } from "@/server/services/messaging-config";

/** Send one test SMS or email now and record whether the provider accepted it (acceptance is not delivery). */
export const POST = staffRoute({ permission: "integrations.write", body: testMessageInput }, async ({ ctx, body }) => ({ data: await sendTestMessage(ctx, body) }));
