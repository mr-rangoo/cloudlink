import { customerRoute } from "@/server/api/handler";
import { audit } from "@/server/audit/audit";
import { getPreferences, preferencesInput, savePreferences } from "@/server/services/notifications";

export const GET = customerRoute({}, async ({ ctx }) => ({ data: await getPreferences(ctx.organizationId, ctx.subscriberId) }));

export const PUT = customerRoute({ body: preferencesInput }, async ({ ctx, body }) => {
  const data = await savePreferences(ctx.organizationId, ctx.subscriberId, body);
  await audit(ctx, { action: "portal.preferences_update", entityType: "subscriber", entityId: ctx.subscriberId, metadata: body });
  return { data };
});
