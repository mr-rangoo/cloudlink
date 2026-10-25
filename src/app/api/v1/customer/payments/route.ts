import { customerRoute } from "@/server/api/handler";
import { listCustomerPayments } from "@/server/portal/services";
import { customerPaymentInput, initiateCustomerPayment } from "@/server/services/mobile-money";

export const GET = customerRoute({}, async ({ ctx }) => ({ data: await listCustomerPayments(ctx) }));

/**
 * Pay with M-Pesa (STK Push) for the signed-in customer's own account or invoice. Returns a payment request whose
 * status comes only from the provider's confirmed callback; poll GET /customer/payments/attempts/:id.
 */
export const POST = customerRoute({ body: customerPaymentInput }, async ({ ctx, body }) => ({ data: await initiateCustomerPayment(ctx, body), status: 202 }));
