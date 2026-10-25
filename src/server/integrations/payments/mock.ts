import "server-only";
import { randomBytes } from "node:crypto";
import { PermanentError } from "@/server/jobs/operations";
import { stkOutcome } from "@/server/domain/mpesa";
import type { C2bUrls, PaymentGateway, PaymentQueryResult, PaymentRequest, PaymentRequestResult, QueryContext } from "@/server/integrations/payments/gateway";

/**
 * Development/test gateway. It never sends a prompt and never invents a successful payment: an attempt stays
 * pending until a staff member explicitly simulates the customer's response (non-production only), and that
 * simulation goes through the same callback validation pipeline. Simulated payments are labelled everywhere.
 * Phone numbers ending in 000 are rejected, to exercise the failure path.
 */
export class MockGateway implements PaymentGateway {
  readonly provider = "mock" as const;

  async requestPayment(req: PaymentRequest): Promise<PaymentRequestResult> {
    if (req.phone.endsWith("000")) throw new PermanentError("M-Pesa rejected the request: Invalid PhoneNumber (simulated)", "MPESA_REJECTED");
    const id = randomBytes(6).toString("hex").toUpperCase();
    return { merchantRequestId: `MOCK-${id}`, checkoutRequestId: `ws_CO_MOCK_${id}`, customerMessage: "Simulated request: no prompt was sent to any phone." };
  }

  async queryPayment(_checkoutRequestId: string, ctx?: QueryContext): Promise<PaymentQueryResult> {
    if (ctx?.mockResultCode) return { outcome: stkOutcome(ctx.mockResultCode), resultCode: ctx.mockResultCode, resultDesc: "Simulated response" };
    const age = ctx?.createdAt ? Date.now() - ctx.createdAt.getTime() : 0;
    if (age > 5 * 60_000) return { outcome: "EXPIRED", resultCode: "1037", resultDesc: "No simulated response was given (simulated timeout)" };
    return { outcome: "PENDING", resultCode: null, resultDesc: "Waiting for a simulated customer response" };
  }

  async testCredentials(): Promise<void> {}

  async registerC2bUrls(_urls: C2bUrls): Promise<void> {
    throw new PermanentError("C2B registration is not available with the mock payment adapter", "MOCK_UNSUPPORTED");
  }
}
