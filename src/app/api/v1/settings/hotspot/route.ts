import { staffRoute } from "@/server/api/handler";
import { getHotspotSettings, hotspotSettingsInput, saveHotspotSettings } from "@/server/services/hotspot-settings";

export const GET = staffRoute({ permission: "settings.write" }, async ({ ctx }) => ({ data: await getHotspotSettings(ctx) }));

/** Captive portal template, headline, how-to-buy steps, support contacts and visible tabs. */
export const PUT = staffRoute({ permission: "settings.write", body: hotspotSettingsInput }, async ({ ctx, body }) => ({ data: await saveHotspotSettings(ctx, body) }));
