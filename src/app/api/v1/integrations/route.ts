import { staffRoute } from "@/server/api/handler";
import { integrationStatus } from "@/server/services/integrations";

/** Integration status (never includes secrets). */
export const GET = staffRoute({ permission: "integrations.read" }, async ({ ctx }) => ({ data: await integrationStatus(ctx) }));
