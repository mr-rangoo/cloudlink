import { staffRoute, uuidParam } from "@/server/api/handler";
import { createStaffResetLink } from "@/server/services/admin";

export const POST = staffRoute({ permission: "staff.write", params: uuidParam }, async ({ ctx, params }) => ({ data: await createStaffResetLink(ctx, params.id) }));
