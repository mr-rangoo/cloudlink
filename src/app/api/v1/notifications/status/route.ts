import { staffRoute } from "@/server/api/handler";
import { messagingInUse } from "@/server/services/messaging-config";

/** Messaging integration status (never includes credentials). */
export const GET = staffRoute({ permission: "notifications.read" }, async ({ ctx }) => ({ data: await messagingInUse(ctx.organizationId) }));
