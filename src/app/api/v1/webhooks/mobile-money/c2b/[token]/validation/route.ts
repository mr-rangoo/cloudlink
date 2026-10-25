import { webhookRoute } from "@/server/api/webhook";
import { handleC2bValidationRequest } from "@/server/services/mobile-money";

/** M-Pesa C2B validation (only used when Safaricom enabled external validation for the shortcode). */
export const POST = webhookRoute(handleC2bValidationRequest);
