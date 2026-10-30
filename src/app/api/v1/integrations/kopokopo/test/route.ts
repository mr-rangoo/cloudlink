import { staffRoute } from "@/server/api/handler";
import { testKopoKopoCredentials } from "@/server/services/payment-gateways";

/** Fetch an access token to check the credentials. Moves no money and does not mark the gateway verified. */
export const POST = staffRoute({ permission: "integrations.write" }, async ({ ctx }) => ({ data: await testKopoKopoCredentials(ctx) }));
