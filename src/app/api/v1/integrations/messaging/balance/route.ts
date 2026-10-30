import { staffRoute } from "@/server/api/handler";
import { checkSmsBalance } from "@/server/services/messaging-config";

/** Ask the SMS provider for the prepaid balance (Africa's Talking and Twilio report one). */
export const POST = staffRoute({ permission: "integrations.read" }, async ({ ctx }) => ({ data: await checkSmsBalance(ctx) }));
