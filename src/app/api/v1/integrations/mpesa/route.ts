import { staffRoute } from "@/server/api/handler";
import { getMpesaSettings, mpesaConfigInput, saveMpesaSettings } from "@/server/services/mpesa-config";

/** M-Pesa settings (credentials are never returned; C2B URLs only to staff who can configure integrations). */
export const GET = staffRoute({ permission: "integrations.read" }, async ({ ctx }) => ({ data: await getMpesaSettings(ctx) }));

/** Save M-Pesa settings. Omit the three credential fields to keep the stored ones. */
export const PUT = staffRoute({ permission: "integrations.write", body: mpesaConfigInput }, async ({ ctx, body }) => ({ data: await saveMpesaSettings(ctx, body) }));
