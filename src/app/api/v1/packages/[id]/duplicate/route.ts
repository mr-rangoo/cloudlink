import { staffRoute, uuidParam } from "@/server/api/handler";
import { duplicatePackage } from "@/server/services/packages";

/** Copy a plan; the copy starts Off with its own router profile name. */
export const POST = staffRoute({ permission: "packages.write", params: uuidParam }, async ({ ctx, params }) => ({ data: await duplicatePackage(ctx, params.id), status: 201 }));
