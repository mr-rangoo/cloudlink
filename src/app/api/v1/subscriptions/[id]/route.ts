import { staffRoute, uuidParam } from "@/server/api/handler";
import { getSubscription } from "@/server/services/subscriptions";

export const GET = staffRoute({ permission: "subscriptions.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getSubscription(ctx, params.id) }));
