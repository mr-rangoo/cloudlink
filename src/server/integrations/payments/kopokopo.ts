import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { logger } from "@/server/observability/logger";
import type { C2bUrls, PaymentGateway, PaymentQueryResult, PaymentRequest, PaymentRequestResult } from "@/server/integrations/payments/gateway";

/**
 * Kopo Kopo K2 Connect adapter: M-PESA STK Push into a Kopo Kopo till ("incoming payments").
 * Implemented from Kopo Kopo's API reference (api-docs.kopokopo.com) and their official Node SDK (k2-connect-node):
 * - token: POST {base}/oauth/token, form-encoded client_id, client_secret, grant_type=client_credentials;
 * - request: POST {base}/api/v2/incoming_payments → 201 with a Location header (the request's status URL);
 * - status: GET {base}/api/v2/incoming_payments/{id} → data.attributes.status Pending | Success | Failed;
 * - callbacks: same body as the status, signed in X-KopoKopo-Signature = hex HMAC-SHA256 of the body with the API key.
 * Tested against a fake K2 server only (tests/support/fake-kopokopo.ts). Secrets and tokens are never logged.
 */
export interface KopoKopoConfig {
  environment: "sandbox" | "production";
  clientId: string;
  clientSecret: string;
  /** Signs callbacks (X-KopoKopo-Signature). */
  apiKey: string;
  /** Till number or online-payments account number (K-prefixed). */
  tillNumber: string;
}

const TIMEOUT_MS = 15_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function kopokopoBaseUrl(environment: "sandbox" | "production"): string {
  const override = process.env.APP_ENV !== "production" ? process.env.KOPOKOPO_BASE_URL : "";
  if (override) return override.replace(/\/$/, "");
  return environment === "production" ? "https://api.kopokopo.com" : "https://sandbox.kopokopo.com";
}

/** Constant-time check of X-KopoKopo-Signature against the raw body. */
export function kopokopoSignatureValid(apiKey: string, rawBody: string, signature: string | null | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", apiKey).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const resourceSchema = z
  .object({
    reference: z.string().min(1).max(40),
    amount: z.union([z.string(), z.number()]).transform((v) => Number(v)),
    currency: z.string().length(3),
    sender_phone_number: z.string().max(20).nullish(),
    origination_time: z.string().max(40).nullish(),
    till_number: z.string().max(20).nullish(),
  })
  .passthrough();

/** Body of an incoming-payment status response or callback (only the fields Cloudlink uses). */
export const k2IncomingPaymentSchema = z.object({
  data: z.object({
    id: z.string().regex(ID_RE),
    type: z.literal("incoming_payment"),
    attributes: z.object({
      status: z.enum(["Pending", "Success", "Failed"]),
      event: z
        .object({
          resource: resourceSchema.nullish(),
          errors: z.union([z.array(z.string()), z.string()]).nullish(),
        })
        .nullish(),
    }),
  }),
});
export type K2IncomingPayment = z.infer<typeof k2IncomingPaymentSchema>;

/** Normalised result shared by the callback and the status query. */
export function k2Result(body: K2IncomingPayment) {
  const a = body.data.attributes;
  const errors = a.event?.errors;
  const desc = Array.isArray(errors) ? errors.join("; ") : (errors ?? "");
  const r = a.status === "Success" ? a.event?.resource : null;
  return {
    id: body.data.id,
    status: a.status,
    description: (desc || (a.status === "Success" ? "Payment received" : a.status === "Pending" ? "Waiting for the customer" : "The payment did not complete")).slice(0, 200),
    receipt: r?.reference ?? null,
    amount: r && Number.isFinite(r.amount) ? r.amount : null,
    currency: r?.currency ?? null,
    phone: r?.sender_phone_number ?? null,
    time: r?.origination_time ?? null,
  };
}

async function call(url: string, init: RequestInit): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new RetryableError(timeout ? "Kopo Kopo did not respond in time" : "Kopo Kopo could not be reached", timeout ? "K2_TIMEOUT" : "K2_UNREACHABLE");
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: res.status, headers: res.headers, body };
}

function errorText(body: Record<string, unknown>, fallback: string): string {
  const m = body.error_message ?? body.message ?? body.error_description ?? body.error;
  return (typeof m === "string" ? m : fallback).slice(0, 200);
}

export class KopoKopoGateway implements PaymentGateway {
  readonly provider = "kopokopo" as const;
  private readonly base: string;

  constructor(private readonly cfg: KopoKopoConfig) {
    this.base = kopokopoBaseUrl(cfg.environment);
  }

  private async token(force = false): Promise<string> {
    const key = createHash("sha256").update(`${this.base}|${this.cfg.clientId}`).digest("hex");
    const cached = tokenCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    const form = new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "client_credentials" });
    const { status, body } = await call(`${this.base}/oauth/token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    if (status === 400 || status === 401 || status === 403) throw new PermanentError("Kopo Kopo rejected the client ID or secret", "K2_AUTH");
    if (status >= 500 || status === 429) throw new RetryableError(`Kopo Kopo authentication is unavailable (HTTP ${status})`, "K2_UNAVAILABLE");
    const token = typeof body.access_token === "string" ? body.access_token : "";
    if (status !== 200 || !token) throw new RetryableError("Kopo Kopo returned an unexpected authentication response", "K2_BAD_RESPONSE");
    const ttl = Math.max(60, Number(body.expires_in ?? 3600) - 60) * 1000;
    tokenCache.set(key, { token, expiresAt: Date.now() + ttl });
    return token;
  }

  /** Authenticated request; refreshes the token once when Kopo Kopo says it is invalid. */
  private async authed(path: string, init: RequestInit) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(attempt > 0);
      const res = await call(`${this.base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), accept: "application/json", authorization: `Bearer ${token}` } });
      if (res.status === 401 && attempt === 0) continue;
      return res;
    }
    throw new PermanentError("Kopo Kopo rejected the access token", "K2_AUTH");
  }

  async requestPayment(req: PaymentRequest): Promise<PaymentRequestResult> {
    const { status, headers, body } = await this.authed("/api/v2/incoming_payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payment_channel: "M-PESA STK Push",
        till_number: this.cfg.tillNumber,
        subscriber: { first_name: "Customer", last_name: req.accountReference, phone_number: `+${req.phone}` },
        amount: { currency: "KES", value: req.amount },
        metadata: { reference: req.accountReference, notes: req.description },
        _links: { callback_url: req.callbackUrl },
      }),
    });
    if (status === 201) {
      const location = headers.get("location") ?? "";
      const id = location.split("/").pop() ?? "";
      // The status URL must be on the configured Kopo Kopo host: never follow a location somewhere else.
      if (!ID_RE.test(id) || !location.startsWith(`${this.base}/`)) throw new RetryableError("Kopo Kopo accepted the request but returned an unexpected location", "K2_BAD_RESPONSE");
      return { merchantRequestId: id, checkoutRequestId: id, customerMessage: "Check your phone and enter your M-Pesa PIN." };
    }
    logger.warn({ status }, "kopokopo stk request rejected");
    if (status >= 400 && status < 500 && status !== 429) throw new PermanentError(`Kopo Kopo rejected the request: ${errorText(body, "invalid request")}`, "K2_REJECTED");
    throw new RetryableError(`Kopo Kopo could not process the request (HTTP ${status})`, "K2_UNAVAILABLE");
  }

  async queryPayment(checkoutRequestId: string): Promise<PaymentQueryResult> {
    if (!ID_RE.test(checkoutRequestId)) throw new PermanentError("Not a Kopo Kopo payment request id", "K2_BAD_ID");
    const { status, body } = await this.authed(`/api/v2/incoming_payments/${checkoutRequestId}`, { method: "GET" });
    if (status === 200) {
      const parsed = k2IncomingPaymentSchema.safeParse(body);
      if (!parsed.success || parsed.data.data.id.toLowerCase() !== checkoutRequestId.toLowerCase()) throw new RetryableError("Kopo Kopo returned an unexpected status response", "K2_BAD_RESPONSE");
      const r = k2Result(parsed.data);
      if (r.status === "Pending") return { outcome: "PENDING", resultCode: null, resultDesc: r.description };
      if (r.status === "Failed") return { outcome: "FAILED", resultCode: "K2_FAILED", resultDesc: r.description };
      return { outcome: "SUCCESS", resultCode: "0", resultDesc: r.description, receipt: r.receipt ?? undefined, amount: r.amount ?? undefined, currency: r.currency ?? undefined };
    }
    if (status === 404) throw new PermanentError("Kopo Kopo does not know this payment request", "K2_NOT_FOUND");
    if (status >= 400 && status < 500 && status !== 429) throw new PermanentError(`Kopo Kopo rejected the status query: ${errorText(body, "invalid request")}`, "K2_QUERY_REJECTED");
    throw new RetryableError(`Kopo Kopo status query failed (HTTP ${status})`, "K2_UNAVAILABLE");
  }

  async testCredentials(): Promise<void> {
    await this.token(true);
  }

  async registerC2bUrls(_urls: C2bUrls): Promise<void> {
    throw new PermanentError("Automatic matching of payments made directly to a Kopo Kopo till is not available yet. Record them from Reconciliation.", "K2_UNSUPPORTED");
  }
}

/** Test helper: forget cached access tokens. */
export function clearKopoKopoTokenCache(): void {
  tokenCache.clear();
}
