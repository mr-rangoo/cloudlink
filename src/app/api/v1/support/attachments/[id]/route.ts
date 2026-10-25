import { staffRoute, uuidParam } from "@/server/api/handler";
import { attachmentResponse, readAttachment } from "@/server/services/tickets";

export const runtime = "nodejs";

export const GET = staffRoute({ permission: "support.read", params: uuidParam }, async ({ ctx, params }) => attachmentResponse(await readAttachment(ctx, params.id)));
