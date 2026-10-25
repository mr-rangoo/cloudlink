import { staffRoute, uuidParam } from "@/server/api/handler";
import { retryNetworkOperation } from "@/server/services/network";

/** Re-queue a FAILED operation (refused when a newer operation for the same subscription exists). */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam }, async ({ ctx, params }) => ({ data: await retryNetworkOperation(ctx, params.id), status: 202 }));
