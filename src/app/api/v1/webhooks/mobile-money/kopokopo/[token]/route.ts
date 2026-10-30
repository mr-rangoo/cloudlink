import { webhookRoute } from "@/server/api/webhook";
import { handleKopoKopoCallbackRequest } from "@/server/services/mobile-money";

/**
 * Kopo Kopo incoming-payment result callback. The path carries the payment request's secret token (one per
 * request); the body must also carry a valid X-KopoKopo-Signature made with the organization's API key.
 */
export const POST = webhookRoute(handleKopoKopoCallbackRequest, { signatureHeader: "x-kopokopo-signature" });
