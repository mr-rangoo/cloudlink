import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { portalPlans } from "@/server/services/hotspot-sales";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });
const query = z.object({ router: z.uuid().optional() });

/** Public: live hotspot plans with the price the customer pays (no customer or financial data). */
export const GET = publicRoute({ params, query }, async ({ params, query }) => ({ data: await portalPlans(params.org, query.router ?? null) }));
