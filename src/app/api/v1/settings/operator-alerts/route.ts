import { staffRoute } from "@/server/api/handler";
import { getOperatorAlertSettings, operatorAlertInput, saveOperatorAlertSettings } from "@/server/services/operator-alerts";

/** Who is told when a router goes offline, a network change fails or a payment matches no one, and the daily digest. */
export const GET = staffRoute({ permission: "settings.write" }, async ({ ctx }) => ({ data: await getOperatorAlertSettings(ctx) }));

export const PUT = staffRoute({ permission: "settings.write", body: operatorAlertInput }, async ({ ctx, body }) => ({ data: await saveOperatorAlertSettings(ctx, body) }));
