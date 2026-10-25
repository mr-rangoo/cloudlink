import { staffRoute, uuidParam } from "@/server/api/handler";
import { revealNetworkCredentials } from "@/server/services/network";

/**
 * Reveal the PPPoE username and password for CPE setup. POST because every reveal is audited.
 * The response is never cached and never stored in the idempotency table.
 */
export const POST = staffRoute({ permission: "network.operate", params: uuidParam, secretResponse: true }, async ({ ctx, params }) => ({ data: await revealNetworkCredentials(ctx, params.id) }));
