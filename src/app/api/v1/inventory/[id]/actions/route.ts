import { staffRoute, uuidParam } from "@/server/api/handler";
import { applyItemAction, itemActionInput } from "@/server/services/inventory";

/** assign | return | mark_faulty | repaired | retire — each recorded as a movement. */
export const POST = staffRoute({ permission: "inventory.write", params: uuidParam, body: itemActionInput }, async ({ ctx, params, body }) => ({ data: await applyItemAction(ctx, params.id, body) }));
