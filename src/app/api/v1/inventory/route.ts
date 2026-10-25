import { paginated, staffRoute } from "@/server/api/handler";
import { createItem, inventoryQuery, itemInput, listInventory } from "@/server/services/inventory";

export const GET = staffRoute({ permission: "inventory.read", query: inventoryQuery }, async ({ ctx, query }) => {
  const { rows, total, counts } = await listInventory(ctx, query);
  return { ...paginated(rows, total, query), counts };
});
export const POST = staffRoute({ permission: "inventory.write", body: itemInput }, async ({ ctx, body }) => ({ data: await createItem(ctx, body), status: 201 }));
