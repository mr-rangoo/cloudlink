import { staffRoute, uuidParam } from "@/server/api/handler";
import { syncPackageToRouters } from "@/server/services/packages";

/** Queue a profile push of this plan to every router it is used on (runs in the worker, verified by read-back). */
export const POST = staffRoute({ permission: ["packages.read", "network.operate"], params: uuidParam }, async ({ ctx, params }) => ({ data: await syncPackageToRouters(ctx, params.id), status: 202 }));
