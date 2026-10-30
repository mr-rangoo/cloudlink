import { staffRoute } from "@/server/api/handler";
import { getMessagingSettings } from "@/server/services/messaging-config";

/** SMS and email provider settings and the provider currently in use (credentials are never returned). */
export const GET = staffRoute({ permission: "integrations.read" }, async ({ ctx }) => ({ data: await getMessagingSettings(ctx) }));
