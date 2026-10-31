import { staffRoute, uuidParam } from "@/server/api/handler";
import { deviceUpdateInput, removeTr069Device, updateTr069Device } from "@/server/services/tr069";

/** Change a device's label or subscriber. */
export const PATCH = staffRoute({ permission: "inventory.write", params: uuidParam, body: deviceUpdateInput }, async ({ ctx, params, body }) => ({ data: await updateTr069Device(ctx, params.id, body) }));

/** Remove a device from Cloudlink (the ACS keeps its own record). */
export const DELETE = staffRoute({ permission: "inventory.write", params: uuidParam }, async ({ ctx, params }) => ({ data: await removeTr069Device(ctx, params.id) }));
