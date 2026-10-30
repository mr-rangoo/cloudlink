import { staffRoute } from "@/server/api/handler";
import { kopokopoConfigInput, saveKopoKopoSettings } from "@/server/services/payment-gateways";

/** Save Kopo Kopo settings. Omit the three credential fields to keep the stored ones. */
export const PUT = staffRoute({ permission: "integrations.write", body: kopokopoConfigInput }, async ({ ctx, body }) => ({ data: await saveKopoKopoSettings(ctx, body) }));
