import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { portalRedemptionStatusLimited } from "@/server/services/vouchers";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });
const body = z.object({ redemptionId: z.uuid(), code: z.string().trim().min(6).max(40) });

/** Activation status for the captive portal. The voucher code proves possession; POST keeps it out of URLs/logs. */
export const POST = publicRoute({ params, body, checkOrigin: true }, async ({ params, body, meta }) => ({ data: await portalRedemptionStatusLimited(params.org, body.redemptionId, body.code, meta.ipAddress) }));
