import { z } from "zod";
import { publicRoute } from "@/server/api/handler";
import { redeemFromPortal, redeemInput } from "@/server/services/vouchers";

const params = z.object({ org: z.string().regex(/^[a-z0-9-]{1,50}$/) });

/** Public captive-portal redemption. Rate-limited per client IP and per organization; same-origin only. */
export const POST = publicRoute({ params, body: redeemInput, checkOrigin: true }, async ({ params, body, meta }) => ({ data: await redeemFromPortal(params.org, body, meta), status: 201 }));
