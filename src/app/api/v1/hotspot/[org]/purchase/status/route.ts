import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { hotspotPurchaseStatus, purchaseStatusInput } from "@/server/services/hotspot-sales";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });

/** Public: purchase progress for the holder of the purchase token; login details once paid. */
export const POST = publicRoute({ params, body: purchaseStatusInput, checkOrigin: true }, async ({ params, body, meta }) => ({ data: await hotspotPurchaseStatus(params.org, body, meta.ipAddress) }));
