import { staffRoute } from "@/server/api/handler";
import { firmwareSummary } from "@/server/services/tr069";

/** Firmware versions across the organization's TR-069 devices, by model. */
export const GET = staffRoute({ permission: "inventory.read" }, async ({ ctx }) => ({ data: await firmwareSummary(ctx) }));
