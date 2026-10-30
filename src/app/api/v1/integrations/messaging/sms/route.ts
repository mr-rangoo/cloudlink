import { staffRoute } from "@/server/api/handler";
import { saveSmsSettings, smsSettingsInput } from "@/server/services/messaging-config";

/** Save the SMS provider (Africa's Talking or Twilio). Omit the API key / auth token to keep the stored one. */
export const PUT = staffRoute({ permission: "integrations.write", body: smsSettingsInput }, async ({ ctx, body }) => ({ data: await saveSmsSettings(ctx, body) }));
