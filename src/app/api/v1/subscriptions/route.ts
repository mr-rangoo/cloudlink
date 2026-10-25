import { paginated, staffRoute } from "@/server/api/handler";
import { createSubscription, listSubscriptions, subscriptionCreateInput, subscriptionListQuery } from "@/server/services/subscriptions";

export const GET = staffRoute({ permission: "subscriptions.read", query: subscriptionListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listSubscriptions(ctx, query);
  return paginated(rows, total, query);
});

export const POST = staffRoute({ permission: "subscriptions.write", body: subscriptionCreateInput }, async ({ ctx, body }) => ({
  data: await createSubscription(ctx, body),
  status: 201,
}));
