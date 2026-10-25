import { staffRoute } from "@/server/api/handler";
import { testMpesaCredentials } from "@/server/services/mpesa-config";

/** Fetch an OAuth token to check the credentials. Moves no money and does not mark the integration verified. */
export const POST = staffRoute({ permission: "integrations.write" }, async ({ ctx }) => ({ data: await testMpesaCredentials(ctx) }));
