import { staffRoute } from "@/server/api/handler";
import { requestTr069Sync } from "@/server/services/tr069";

/** Read the organization's devices from the ACS now (runs in the worker). */
export const POST = staffRoute({ permission: "inventory.read" }, async ({ ctx }) => ({ data: await requestTr069Sync(ctx), status: 202 }));
