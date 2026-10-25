import { staffRoute, uuidParam } from "@/server/api/handler";
import { cancelNetworkOperation, cancelOperationInput } from "@/server/services/network";

/** Cancel a QUEUED or RETRYING operation (one already running cannot be cancelled). */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam, body: cancelOperationInput }, async ({ ctx, params, body }) => ({
  data: await cancelNetworkOperation(ctx, params.id, body),
}));
