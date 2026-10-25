import { staffRoute, uuidParam } from "@/server/api/handler";
import { getNetworkOperation } from "@/server/services/network";

/** One operation with its append-only attempt log and related alerts. */
export const GET = staffRoute({ permission: "network.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getNetworkOperation(ctx, params.id) }));
