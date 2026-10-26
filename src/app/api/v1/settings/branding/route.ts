import { staffRoute } from "@/server/api/handler";
import { brandingFor, brandingInput, updateBranding } from "@/server/services/branding";

export const GET = staffRoute({ permission: "settings.write" }, async ({ ctx }) => ({ data: await brandingFor(ctx.organizationId) }));

/** Theme preset, optional brand colour (contrast-checked), default light/dark mode and portal texts. */
export const PUT = staffRoute({ permission: "settings.write", body: brandingInput }, async ({ ctx, body }) => ({ data: await updateBranding(ctx, body) }));
