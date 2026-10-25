import { staffRoute } from "@/server/api/handler";
import { listTemplates, saveTemplate, templateInput } from "@/server/services/notifications";

export const GET = staffRoute({ permission: "notifications.read" }, async ({ ctx }) => ({ data: await listTemplates(ctx) }));
export const PUT = staffRoute({ permission: "notifications.write", body: templateInput }, async ({ ctx, body }) => ({ data: await saveTemplate(ctx, body) }));
