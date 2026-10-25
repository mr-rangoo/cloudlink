import { staffRoute, uuidParam } from "@/server/api/handler";
import { retryNotification } from "@/server/services/notifications";

export const POST = staffRoute({ permission: "notifications.write", params: uuidParam }, async ({ ctx, params }) => {
  await retryNotification(ctx, params.id);
  return { data: { queued: true } };
});
