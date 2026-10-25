import { customerRoute, uuidParam } from "@/server/api/handler";
import { attachmentResponse, readAttachment } from "@/server/services/tickets";

export const runtime = "nodejs";

export const GET = customerRoute({ params: uuidParam }, async ({ ctx, params }) => attachmentResponse(await readAttachment(ctx, params.id)));
