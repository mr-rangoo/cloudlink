import "server-only";
import { createHash } from "node:crypto";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { darajaTimestamp, stkOutcome, stkPassword } from "@/server/domain/mpesa";
import { logger } from "@/server/observability/logger";
import type { C2bUrls, PaymentGateway, PaymentQueryResult, PaymentRequest, PaymentRequestResult } from "@/server/integrations/payments/gateway";

/**
 * Safaricom Daraja adapter: OAuth client credentials, Lipa Na M-Pesa Online (STK Push), STK Push Query and C2B URL
 * registration. Implemented from the public Daraja documentation and tested against a fake Daraja server
 * (tests/support/fake-daraja.ts). Sandbox/production verification happens only with credentials supplied by the
 * operator. Secrets (consumer secret, passkey, access token) are never logged.
 */
export interface DarajaConfig {
  environment: "sandbox" | "production";
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  /** BusinessShortCode: the paybill number, or the store (head office) number for a till. */
  shortcode: string;
  type: "PAYBILL" | "TILL";
  /** PartyB for Buy Goods (till) requests. */
  tillNumber?: string | null;
}

const TIMEOUT_MS = 15_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function darajaBaseUrl(environment: "sandbox" | "production"): string {
  const override = process.env.APP_ENV !== "production" ? process.env.MPESA_BASE_URL : "";
  if (override) return override.replace(/\/$/, "");
  return environment === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
}

interface DarajaError {
  requestId?: string;
  errorCode?: string;
  errorMessage?: string;
}

async function call(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new RetryableError(timeout ? "M-Pesa did not respond in time" : "M-Pesa could not be reached", timeout ? "MPESA_TIMEOUT" : "MPESA_UNREACHABLE");
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

/** Provider error text is shown to staff; keep it short and free of anything we sent. */
function describe(body: DarajaError, fallback: string): string {
  return (body.errorMessage ?? fallback).toString().slice(0, 200);
}

export class DarajaGateway implements PaymentGateway {
  readonly provider = "mpesa_daraja" as const;
  private readonly base: string;

  constructor(private readonly cfg: DarajaConfig) {
    this.base = darajaBaseUrl(cfg.environment);
  }

  private cacheKey(): string {
    return createHash("sha256").update(`${this.base}|${this.cfg.consumerKey}`).digest("hex");
  }

  private async token(force = false): Promise<string> {
    const key = this.cacheKey();
    const cached = tokenCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString("base64");
    const { status, body } = await call(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, { method: "GET", headers: { authorization: `Basic ${basic}` } });
    if (status === 400 || status === 401 || status === 403) throw new PermanentError("M-Pesa rejected the consumer key or secret", "MPESA_AUTH");
    if (status >= 500 || status === 429) throw new RetryableError(`M-Pesa authentication is unavailable (HTTP ${status})`, "MPESA_UNAVAILABLE");
    const token = typeof body.access_token === "string" ? body.access_token : "";
    if (status !== 200 || !token) throw new RetryableError("M-Pesa returned an unexpected authentication response", "MPESA_BAD_RESPONSE");
    const ttl = Math.max(60, Number(body.expires_in ?? 3599) - 60) * 1000;
    tokenCache.set(key, { token, expiresAt: Date.now() + ttl });
    return token;
  }

  /** POST with a bearer token; refreshes the token once if Daraja says it is invalid. */
  private async post(path: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(attempt > 0);
      const res = await call(`${this.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
      const code = (res.body as DarajaError).errorCode ?? "";
      if ((res.status === 401 || code === "404.001.03") && attempt === 0) continue; // invalid/expired access token
      return res;
    }
    throw new PermanentError("M-Pesa rejected the access token", "MPESA_AUTH");
  }

  private password(now = new Date()) {
    const timestamp = darajaTimestamp(now);
    return { timestamp, password: stkPassword(this.cfg.shortcode, this.cfg.passkey, timestamp) };
  }

  async requestPayment(req: PaymentRequest): Promise<PaymentRequestResult> {
    const { timestamp, password } = this.password();
    const till = this.cfg.type === "TILL";
    const { status, body } = await this.post("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: this.cfg.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: till ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
      Amount: req.amount,
      PartyA: req.phone,
      PartyB: till ? (this.cfg.tillNumber ?? this.cfg.shortcode) : this.cfg.shortcode,
      PhoneNumber: req.phone,
      CallBackURL: req.callbackUrl,
      AccountReference: req.accountReference,
      TransactionDesc: req.description,
    });
    const ok = status === 200 && String(body.ResponseCode ?? "") === "0" && typeof body.CheckoutRequestID === "string";
    if (ok) {
      return {
        merchantRequestId: String(body.MerchantRequestID ?? ""),
        checkoutRequestId: String(body.CheckoutRequestID),
        customerMessage: String(body.CustomerMessage ?? "Request accepted for processing"),
      };
    }
    const err = body as DarajaError;
    logger.warn({ status, errorCode: err.errorCode, requestId: err.requestId }, "daraja stk push rejected");
    // A request the provider did not accept never reached the customer: safe to report as failed.
    if (status >= 400 && status < 500) throw new PermanentError(`M-Pesa rejected the request: ${describe(err, "invalid request")}`, "MPESA_REJECTED");
    if (err.errorCode === "500.001.1001") throw new PermanentError("A payment is already being processed on this phone. Wait a minute and try again.", "MPESA_BUSY");
    throw new RetryableError(`M-Pesa could not process the request (HTTP ${status})`, "MPESA_UNAVAILABLE");
  }

  async queryPayment(checkoutRequestId: string): Promise<PaymentQueryResult> {
    const { timestamp, password } = this.password();
    const { status, body } = await this.post("/mpesa/stkpushquery/v1/query", { BusinessShortCode: this.cfg.shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId });
    if (status === 200 && body.ResultCode !== undefined) {
      const resultCode = String(body.ResultCode);
      return { outcome: stkOutcome(resultCode), resultCode, resultDesc: String(body.ResultDesc ?? "") };
    }
    const err = body as DarajaError;
    // While the customer has not finished, Daraja answers the query with "The transaction is being processed".
    if (err.errorCode === "500.001.1001" || /being processed/i.test(err.errorMessage ?? "")) return { outcome: "PENDING", resultCode: null, resultDesc: "Waiting for the customer" };
    if (status >= 400 && status < 500) throw new PermanentError(`M-Pesa rejected the status query: ${describe(err, "invalid request")}`, "MPESA_QUERY_REJECTED");
    throw new RetryableError(`M-Pesa status query failed (HTTP ${status})`, "MPESA_UNAVAILABLE");
  }

  async testCredentials(): Promise<void> {
    await this.token(true);
  }

  async registerC2bUrls(urls: C2bUrls): Promise<void> {
    const { status, body } = await this.post("/mpesa/c2b/v1/registerurl", {
      ShortCode: this.cfg.type === "TILL" ? (this.cfg.tillNumber ?? this.cfg.shortcode) : this.cfg.shortcode,
      ResponseType: "Completed",
      ConfirmationURL: urls.confirmationUrl,
      ValidationURL: urls.validationUrl,
    });
    const description = String(body.ResponseDescription ?? body.ResponseDesc ?? "");
    if (status === 200 && (String(body.ResponseCode ?? "") === "0" || /success/i.test(description))) return;
    const err = body as DarajaError;
    if (status >= 400 && status < 500) throw new PermanentError(`M-Pesa refused the URL registration: ${describe(err, description || "invalid request")}`, "MPESA_REJECTED");
    throw new RetryableError(`M-Pesa URL registration failed (HTTP ${status})`, "MPESA_UNAVAILABLE");
  }
}

/** Test helper: forget cached access tokens. */
export function clearDarajaTokenCache(): void {
  tokenCache.clear();
}
