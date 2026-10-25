import { paginated, staffRoute } from "@/server/api/handler";
import { listNotifications, notificationListQuery } from "@/server/services/notifications";

export const GET = staffRoute({ permission: "notifications.read", query: notificationListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listNotifications(ctx, query);
  return paginated(rows, total, query);
});
