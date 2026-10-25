import { webhookRoute } from "@/server/api/webhook";
import { handleC2bConfirmationRequest } from "@/server/services/mobile-money";

/** M-Pesa C2B confirmation (payments made directly to the paybill/till). The token identifies the organization. */
export const POST = webhookRoute(handleC2bConfirmationRequest);
