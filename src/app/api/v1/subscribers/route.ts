import { paginated, staffRoute } from "@/server/api/handler";
import { createSubscriber, listSubscribers, subscriberInput, subscriberListQuery } from "@/server/services/subscribers";

export const GET = staffRoute({ permission: "subscribers.read", query: subscriberListQuery }, async ({ ctx, query }) => {
  const { rows, total } = await listSubscribers(ctx, query);
  return paginated(rows, total, query);
});

export const POST = staffRoute({ permission: "subscribers.write", body: subscriberInput }, async ({ ctx, body }) => ({ data: await createSubscriber(ctx, body), status: 201 }));
