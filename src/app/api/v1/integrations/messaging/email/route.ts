import { staffRoute } from "@/server/api/handler";
import { emailSettingsInput, saveEmailSettings } from "@/server/services/messaging-config";

/** Save the SMTP server. Omit the password to keep the stored one. */
export const PUT = staffRoute({ permission: "integrations.write", body: emailSettingsInput }, async ({ ctx, body }) => ({ data: await saveEmailSettings(ctx, body) }));
