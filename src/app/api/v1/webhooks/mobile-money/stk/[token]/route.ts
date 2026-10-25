import { webhookRoute } from "@/server/api/webhook";
import { handleStkCallbackRequest } from "@/server/services/mobile-money";

/**
 * M-Pesa STK Push result callback. The path carries the payment request's secret token (one per request).
 * The path avoids the words "mpesa"/"safaricom", which Daraja refuses in registered URLs.
 */
export const POST = webhookRoute(handleStkCallbackRequest);
