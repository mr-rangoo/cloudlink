import { staffRoute } from "@/server/api/handler";
import { assistantSettings, assistantSettingsInput, assistantStatus, updateAssistantSettings } from "@/server/assistant/service";

export const GET = staffRoute({ permission: "settings.write" }, async ({ ctx }) => ({ data: { ...(await assistantSettings(ctx.organizationId)), status: assistantStatus() } }));

/** Turn the portal assistant on or off, name it, and add organization-specific guidance. */
export const PUT = staffRoute({ permission: "settings.write", body: assistantSettingsInput }, async ({ ctx, body }) => ({ data: await updateAssistantSettings(ctx, body) }));
