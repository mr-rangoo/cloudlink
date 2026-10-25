import { staffRoute, uuidParam } from "@/server/api/handler";
import { db } from "@/server/db/client";
import { tenantWhere } from "@/server/auth/context";
import { notFound } from "@/server/errors";
import { audit } from "@/server/audit/audit";
import { getPreferences, preferencesInput, savePreferences } from "@/server/services/notifications";

async function assertSubscriber(ctx: Parameters<typeof tenantWhere>[0], id: string) {
  if (!(await db.subscriber.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true } }))) throw notFound("subscriber");
}

export const GET = staffRoute({ permission: "subscribers.read", params: uuidParam }, async ({ ctx, params }) => {
  await assertSubscriber(ctx, params.id);
  return { data: await getPreferences(ctx.organizationId, params.id) };
});

export const PUT = staffRoute({ permission: "subscribers.write", params: uuidParam, body: preferencesInput }, async ({ ctx, params, body }) => {
  await assertSubscriber(ctx, params.id);
  const data = await savePreferences(ctx.organizationId, params.id, body);
  await audit(ctx, { action: "notification_preferences.update", entityType: "subscriber", entityId: params.id, metadata: body });
  return { data };
});
