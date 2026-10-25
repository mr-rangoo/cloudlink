import { customerRoute, uuidParam } from "@/server/api/handler";
import { addCustomerComment, customerCommentInput } from "@/server/services/tickets";

export const POST = customerRoute({ params: uuidParam, body: customerCommentInput }, async ({ ctx, params, body }) => ({ data: await addCustomerComment(ctx, params.id, body.body), status: 201 }));
