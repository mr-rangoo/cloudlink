import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { reconnectHotspot, reconnectInput } from "@/server/services/hotspot-sales";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });

/** Public "Already paid?": M-Pesa code + paying phone returns the login details again. Failures are rate-limited per IP. */
export const POST = publicRoute({ params, body: reconnectInput, checkOrigin: true }, async ({ params, body, meta }) => ({ data: await reconnectHotspot(params.org, body, meta) }));
