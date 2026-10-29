import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { purchaseInput, startHotspotPurchase } from "@/server/services/hotspot-sales";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });

/** Public captive-portal purchase: sends an M-Pesa prompt (or grants a free trial). Rate-limited; same-origin only. */
export const POST = publicRoute({ params, body: purchaseInput, checkOrigin: true }, async ({ params, body, meta }) => ({ data: await startHotspotPurchase(params.org, body, meta), status: 201 }));
