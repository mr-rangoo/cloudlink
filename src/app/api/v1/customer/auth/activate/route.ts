import { publicRoute } from "@/server/api/handler";
import { activatePortalAccount, portalActivateInput } from "@/server/portal/auth";

/** Set a password from a single-use invite link. */
export const POST = publicRoute({ body: portalActivateInput, checkOrigin: true }, async ({ body, meta }) => ({ data: await activatePortalAccount(body, meta) }));
