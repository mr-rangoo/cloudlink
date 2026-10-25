import { staffRoute } from "@/server/api/handler";
import { getSettings, settingsInput, updateSettings } from "@/server/services/admin";

export const GET = staffRoute({ permission: "settings.write" }, async ({ ctx }) => ({ data: await getSettings(ctx) }));
export const PATCH = staffRoute({ permission: "settings.write", body: settingsInput }, async ({ ctx, body }) => ({ data: await updateSettings(ctx, body) }));
