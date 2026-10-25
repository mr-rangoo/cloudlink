import { staffRoute, uuidParam } from "@/server/api/handler";
import { addStaffComment, commentInput } from "@/server/services/tickets";

/** Reply to the customer (notifies them) or add an internal note (staff only). */
export const POST = staffRoute({ permission: "support.write", params: uuidParam, body: commentInput }, async ({ ctx, params, body }) => ({ data: await addStaffComment(ctx, params.id, body), status: 201 }));
