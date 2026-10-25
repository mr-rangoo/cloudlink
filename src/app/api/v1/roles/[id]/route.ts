import { staffRoute, uuidParam } from "@/server/api/handler";
import { deleteRole, roleInput, updateRole } from "@/server/services/admin";

export const PATCH = staffRoute({ permission: "roles.write", params: uuidParam, body: roleInput }, async ({ ctx, params, body }) => ({ data: await updateRole(ctx, params.id, body) }));
export const DELETE = staffRoute({ permission: "roles.write", params: uuidParam }, async ({ ctx, params }) => {
  await deleteRole(ctx, params.id);
  return { data: { deleted: true } };
});
