import { staffRoute, uuidParam } from "@/server/api/handler";
import { staffUpdateInput, updateStaff } from "@/server/services/admin";

/** :id is the membership id. Role/branch/status changes revoke the member's sessions in this organization. */
export const PATCH = staffRoute({ permission: "staff.write", params: uuidParam, body: staffUpdateInput }, async ({ ctx, params, body }) => {
  await updateStaff(ctx, params.id, body);
  return { data: { ok: true } };
});
