import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { accessStatusInput, hotspotAccessStatus } from "@/server/services/hotspot-sales";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });

/** Public: whether the router is ready for a login the caller already holds (the login details are the proof). */
export const POST = publicRoute({ params, body: accessStatusInput, checkOrigin: true }, async ({ params, body, meta }) => ({ data: await hotspotAccessStatus(params.org, body, meta.ipAddress) }));
