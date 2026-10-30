import { publicRoute } from "@/server/api/handler";
import { requestPortalSetupLink, setupLinkInput } from "@/server/portal/signup";

/** Send a portal setup / password link to the contacts on file (same reply whether or not the account exists). */
export const POST = publicRoute({ body: setupLinkInput, checkOrigin: true }, async ({ body, meta }) => ({ data: await requestPortalSetupLink(body, meta), status: 202 }));
