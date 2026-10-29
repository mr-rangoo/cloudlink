import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { purchaseSimulateInput, simulateHotspotPayment } from "@/server/services/hotspot-sales";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });

/** Test mode only (mock payment adapter, never production): play the customer's M-Pesa response. */
export const POST = publicRoute({ params, body: purchaseSimulateInput, checkOrigin: true }, async ({ params, body, meta }) => ({ data: await simulateHotspotPayment(params.org, body, meta) }));
