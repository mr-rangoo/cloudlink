import { staffRoute } from "@/server/api/handler";
import { createPackage, listPackages, packageInput, packageListQuery } from "@/server/services/packages";

export const GET = staffRoute({ permission: "packages.read", query: packageListQuery }, async ({ ctx, query }) => ({ data: await listPackages(ctx, query) }));

export const POST = staffRoute({ permission: "packages.write", body: packageInput }, async ({ ctx, body }) => ({ data: await createPackage(ctx, body), status: 201 }));
