import { staffRoute, uuidParam } from "@/server/api/handler";
import { createSetupCommand } from "@/server/services/router-setup";

/**
 * Generate a one-time router setup command (valid 30 minutes, single use). The response contains a secret link:
 * it is never stored in the idempotency table. Generating a new command invalidates the previous one.
 */
export const POST = staffRoute({ permission: "routers.write", params: uuidParam, secretResponse: true }, async ({ ctx, params }) => ({ data: await createSetupCommand(ctx, params.id) }));
