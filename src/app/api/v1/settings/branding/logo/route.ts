import { readUploadedFile, staffRoute } from "@/server/api/handler";
import { MAX_LOGO_BYTES, removeLogo, uploadLogo } from "@/server/services/branding";

/** Upload the organization logo (multipart field "file"; PNG, JPEG or WebP, 512 KB max; content is sniffed). */
export const POST = staffRoute({ permission: "settings.write" }, async ({ ctx, req }) => ({ data: await uploadLogo(ctx, await readUploadedFile(req, "file", MAX_LOGO_BYTES + 64 * 1024)) }));

export const DELETE = staffRoute({ permission: "settings.write" }, async ({ ctx }) => ({ data: await removeLogo(ctx) }));
