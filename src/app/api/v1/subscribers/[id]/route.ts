import { staffRoute, uuidParam } from "@/server/api/handler";
import { getSubscriber, subscriberUpdate, updateSubscriber } from "@/server/services/subscribers";

export const GET = staffRoute({ permission: "subscribers.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getSubscriber(ctx, params.id) }));

export const PATCH = staffRoute({ permission: "subscribers.write", params: uuidParam, body: subscriberUpdate }, async ({ ctx, params, body }) => ({
  data: await updateSubscriber(ctx, params.id, body),
}));
