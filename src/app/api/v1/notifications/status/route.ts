import { staffRoute } from "@/server/api/handler";
import { messagingStatus } from "@/server/integrations/messaging";

/** Messaging integration status (never includes credentials). */
export const GET = staffRoute({ permission: "notifications.read" }, async () => ({ data: messagingStatus() }));
