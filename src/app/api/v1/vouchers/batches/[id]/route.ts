import { staffRoute, uuidParam } from "@/server/api/handler";
import { getBatch } from "@/server/services/vouchers";

export const GET = staffRoute({ permission: "vouchers.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getBatch(ctx, params.id) }));
