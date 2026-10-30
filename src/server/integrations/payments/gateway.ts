import "server-only";
import type { MpesaOutcome } from "@/server/domain/mpesa";

/**
 * Payment gateway boundary. Business code depends on this interface only; providers are adapters.
 * A gateway never records money: it requests payments and reports what the provider says. Money is recorded
 * only after a validated, verified callback (see services/mobile-money.ts).
 *
 * Adding a provider: implement this interface, add it to resolveGateway(), give it a mock for tests, and do not
 * report it as available until it has been tested against the provider's sandbox.
 */
export type GatewayProvider = "mpesa_daraja" | "kopokopo" | "mock";

export interface PaymentRequest {
  amount: number; // whole currency units
  phone: string; // MSISDN
  accountReference: string;
  description: string;
  callbackUrl: string;
}

export interface PaymentRequestResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage: string;
}

export interface PaymentQueryResult {
  outcome: MpesaOutcome;
  resultCode: string | null;
  resultDesc: string;
  /** Providers whose status query reports the transaction itself (e.g. Kopo Kopo) also return its receipt and amount. */
  receipt?: string;
  amount?: number;
  currency?: string;
}

export interface C2bUrls {
  confirmationUrl: string;
  validationUrl: string;
}

export interface QueryContext {
  /** Mock only: the simulated customer response recorded on the attempt. */
  mockResultCode?: string | null;
  createdAt?: Date;
}

export interface PaymentGateway {
  readonly provider: GatewayProvider;
  /** Ask the provider to collect a payment (e.g. STK Push). Throws PermanentError or RetryableError. */
  requestPayment(req: PaymentRequest): Promise<PaymentRequestResult>;
  /** Ask the provider for the final state of a request. */
  queryPayment(checkoutRequestId: string, ctx?: QueryContext): Promise<PaymentQueryResult>;
  /** Check credentials without moving money. */
  testCredentials(): Promise<void>;
  /** Register C2B confirmation/validation URLs (paybill/till payments made directly by customers). */
  registerC2bUrls(urls: C2bUrls): Promise<void>;
}
