import { staffRoute, uuidParam } from "@/server/api/handler";
import { getItem } from "@/server/services/inventory";

export const GET = staffRoute({ permission: "inventory.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getItem(ctx, params.id) }));
