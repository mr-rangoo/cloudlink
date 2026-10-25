import { staffRoute, uuidParam } from "@/server/api/handler";
import { getPackage, packageUpdate, updatePackage } from "@/server/services/packages";

export const GET = staffRoute({ permission: "packages.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getPackage(ctx, params.id) }));

export const PATCH = staffRoute({ permission: "packages.write", params: uuidParam, body: packageUpdate }, async ({ ctx, params, body }) => ({
  data: await updatePackage(ctx, params.id, body),
}));
