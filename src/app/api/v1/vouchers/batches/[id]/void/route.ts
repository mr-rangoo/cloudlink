import { z } from "zod";
import { staffRoute, uuidParam } from "@/server/api/handler";
import { voidBatch } from "@/server/services/vouchers";

export const POST = staffRoute({ permission: "vouchers.write", params: uuidParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async ({ ctx, params, body }) => ({ data: await voidBatch(ctx, params.id, body.reason) }));
