import { publicRoute } from "@/server/api/handler";
import { requestService, serviceRequestInput } from "@/server/portal/signup";

/** A prospective customer asks for a connection; becomes a lead for the provider (rate-limited, honeypot). */
export const POST = publicRoute({ body: serviceRequestInput, checkOrigin: true }, async ({ body, meta }) => ({ data: await requestService(body, meta), status: 202 }));
