import { staffRoute } from "@/server/api/handler";
import { createRole, listRoles, roleInput } from "@/server/services/admin";

export const GET = staffRoute({ permission: "staff.read" }, async ({ ctx }) => ({ data: await listRoles(ctx) }));
export const POST = staffRoute({ permission: "roles.write", body: roleInput }, async ({ ctx, body }) => ({ data: await createRole(ctx, body), status: 201 }));
