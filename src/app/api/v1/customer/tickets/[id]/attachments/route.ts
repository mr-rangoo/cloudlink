import { customerRoute, readUploadedFile, uuidParam } from "@/server/api/handler";
import { addAttachment } from "@/server/services/tickets";

export const runtime = "nodejs";

export const POST = customerRoute({ params: uuidParam }, async ({ ctx, params, req }) => ({ data: await addAttachment(ctx, params.id, await readUploadedFile(req)), status: 201 }));
