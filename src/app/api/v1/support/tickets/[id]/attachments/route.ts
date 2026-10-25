import { readUploadedFile, staffRoute, uuidParam } from "@/server/api/handler";
import { addAttachment } from "@/server/services/tickets";

export const runtime = "nodejs";

/** multipart/form-data with a single "file" field; content type is verified from the bytes. */
export const POST = staffRoute({ permission: "support.write", params: uuidParam }, async ({ ctx, params, req }) => ({ data: await addAttachment(ctx, params.id, await readUploadedFile(req)), status: 201 }));
