import "server-only";
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { isPublicAddress } from "@/server/domain/network-address";
import { logger, maskContact } from "@/server/observability/logger";

/**
 * Messaging adapters (server-side only). Integration status values follow INTEGRATIONS.md.
 * - Mock adapters are deterministic, never contact a provider, and mark messages as simulated.
 * - Providers are configured per organization (Integrations page) or, for single-tenant deployments, through
 *   SMTP_* / SMS_* environment variables. Africa's Talking, Twilio and SMTP are implemented from public
 *   documentation and tested against local fakes only: NOT verified with real accounts.
 * - A missing configuration yields a NotConfigured adapter: messages are SKIPPED, never reported as sent.
 * - "Accepted" means the provider took the message; it is not proof of delivery to the handset or inbox.
 */
export type IntegrationStatus = "not_configured" | "mock" | "sandbox_tested" | "production_verified" | "error";

export interface SendResult {
  providerMessageId: string;
  simulated: boolean;
}

export interface Balance {
  amount: string;
  currency: string;
}

export interface MessageAdapter {
  provider: string;
  status: IntegrationStatus;
  /** False when messages cannot be sent at all (caller records SKIPPED). */
  available: boolean;
  send(msg: { to: string; subject?: string | null; body: string }): Promise<SendResult>;
  /** Prepaid credit at the provider, where the provider reports it. */
  balance?(): Promise<Balance>;
}

export type SmsConfig =
  | { provider: "africastalking"; username: string; apiKey: string; senderId: string | null }
  | { provider: "twilio"; accountSid: string; authToken: string; from: string };

export interface SmtpConfig {
  host: string;
  port: number;
  /** ssl = TLS from the start (usually 465); starttls = upgrade required (usually 587); none = plain (not in production). */
  security: "ssl" | "starttls" | "none";
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
}

const TIMEOUT_MS = 10_000;
const MAIL_PORTS = [25, 465, 587, 2525];

/** mock (development default), live (configured providers), disabled. "smtp" is the older name for live. */
export function messagingMode(): "mock" | "live" | "disabled" {
  const mode = process.env.MESSAGING_ADAPTER ?? "mock";
  if (mode === "mock") return "mock";
  if (mode === "live" || mode === "smtp") return "live";
  return "disabled";
}

/** Test-only: point provider HTTP calls at a local fake (ignored outside APP_ENV=test). */
function vendorUrl(url: string): string {
  const base = process.env.APP_ENV === "test" ? process.env.MESSAGING_TEST_BASE_URL : undefined;
  if (!base) return url;
  const u = new URL(url);
  return `${base.replace(/\/$/, "")}${u.pathname}${u.search}`;
}

async function post(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(vendorUrl(url), { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new RetryableError(`${label} unreachable`, "SMS_TIMEOUT");
  }
}

class MockAdapter implements MessageAdapter {
  status = "mock" as const;
  available = true;
  constructor(public provider: string) {}
  async send(msg: { to: string; subject?: string | null; body: string }): Promise<SendResult> {
    const id = createHash("sha256").update(`${msg.to}|${msg.subject ?? ""}|${msg.body}`).digest("hex").slice(0, 16);
    logger.info({ provider: this.provider, to: maskContact(msg.to) }, "mock message accepted (simulated, not delivered)");
    return { providerMessageId: `mock-${id}`, simulated: true };
  }
}

class NotConfiguredAdapter implements MessageAdapter {
  status = "not_configured" as const;
  available = false;
  constructor(public provider: string) {}
  async send(): Promise<SendResult> {
    throw new PermanentError(`${this.provider} is not configured`, "NOT_CONFIGURED");
  }
}

/** Refuse SMTP hosts that are, or resolve to, non-public addresses (production), and non-mail ports. */
async function assertMailHost(cfg: SmtpConfig) {
  if (process.env.APP_ENV !== "production") return;
  if (!MAIL_PORTS.includes(cfg.port)) throw new PermanentError(`SMTP port ${cfg.port} is not allowed (use 25, 465, 587 or 2525)`, "SMTP_PORT_REFUSED");
  if (cfg.security === "none") throw new PermanentError("Unencrypted SMTP is not allowed in production", "SMTP_TLS_REQUIRED");
  const addresses = net.isIP(cfg.host) ? [cfg.host] : (await dns.lookup(cfg.host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new RetryableError("SMTP host could not be resolved", "SMTP_DNS");
  if (!addresses.every(isPublicAddress)) throw new PermanentError("The SMTP host resolves to a private or reserved address", "SMTP_HOST_REFUSED");
}

class SmtpAdapter implements MessageAdapter {
  provider = "smtp";
  status = "not_configured" as IntegrationStatus; // a recorded real test is needed before this is "verified"
  available = true;
  constructor(private cfg: SmtpConfig) {}
  async send(msg: { to: string; subject?: string | null; body: string }): Promise<SendResult> {
    await assertMailHost(this.cfg);
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.security === "ssl",
      requireTLS: this.cfg.security === "starttls",
      ignoreTLS: this.cfg.security === "none",
      auth: this.cfg.username ? { user: this.cfg.username, pass: this.cfg.password ?? "" } : undefined,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
    try {
      const from = this.cfg.fromName ? { name: this.cfg.fromName, address: this.cfg.fromAddress } : this.cfg.fromAddress;
      const info = await transport.sendMail({ from, to: msg.to, subject: msg.subject ?? "Cloudlink", text: msg.body });
      return { providerMessageId: String(info.messageId ?? ""), simulated: false };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number };
      if (e.code === "EAUTH") throw new PermanentError("SMTP login rejected", "SMTP_AUTH");
      if (e.responseCode && e.responseCode >= 500) throw new PermanentError("SMTP rejected the message", `SMTP_${e.responseCode}`);
      throw new RetryableError("SMTP temporarily unavailable", "SMTP_TRANSIENT");
    }
  }
}

/** Africa's Talking bulk SMS (form-encoded POST) and user balance. From public API documentation; unverified. */
class AfricasTalkingAdapter implements MessageAdapter {
  provider = "africastalking";
  status = "not_configured" as IntegrationStatus;
  available = true;
  constructor(private cfg: Extract<SmsConfig, { provider: "africastalking" }>) {}
  private get host() {
    return this.cfg.username === "sandbox" ? "https://api.sandbox.africastalking.com" : "https://api.africastalking.com";
  }
  async send(msg: { to: string; body: string }): Promise<SendResult> {
    const form = new URLSearchParams({ username: this.cfg.username, to: `+${msg.to.replace(/^\+/, "")}`, message: msg.body });
    if (this.cfg.senderId) form.set("from", this.cfg.senderId);
    const res = await post(`${this.host}/version1/messaging`, { method: "POST", headers: { apiKey: this.cfg.apiKey, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form }, "SMS provider");
    if (res.status >= 500) throw new RetryableError(`SMS provider error ${res.status}`, "SMS_5XX");
    if (res.status === 401) throw new PermanentError("SMS provider rejected the API key", "SMS_AUTH");
    if (!res.ok) throw new PermanentError(`SMS provider rejected the request (${res.status})`, "SMS_REJECTED");
    const json = (await res.json().catch(() => null)) as { SMSMessageData?: { Recipients?: Array<{ statusCode?: number; messageId?: string; status?: string }> } } | null;
    const r = json?.SMSMessageData?.Recipients?.[0];
    if (!r || (r.statusCode !== 100 && r.statusCode !== 101 && r.statusCode !== 102)) throw new PermanentError(`SMS not accepted: ${r?.status ?? "unknown"}`, "SMS_NOT_ACCEPTED");
    return { providerMessageId: r.messageId ?? "", simulated: false };
  }
  async balance(): Promise<Balance> {
    const res = await post(`${this.host}/version1/user?username=${encodeURIComponent(this.cfg.username)}`, { method: "GET", headers: { apiKey: this.cfg.apiKey, accept: "application/json" } }, "SMS provider");
    if (res.status === 401) throw new PermanentError("SMS provider rejected the API key", "SMS_AUTH");
    if (!res.ok) throw new RetryableError(`SMS provider error ${res.status}`, "SMS_BALANCE");
    const json = (await res.json().catch(() => null)) as { UserData?: { balance?: string } } | null;
    const m = /^([A-Z]{3})\s*(-?[\d.,]+)$/.exec(json?.UserData?.balance?.trim() ?? "");
    if (!m) throw new PermanentError("The provider did not return a balance", "SMS_BALANCE");
    return { currency: m[1]!, amount: Number(m[2]!.replace(/,/g, "")).toFixed(2) };
  }
}

/** Twilio Programmable Messaging and account balance (basic auth). From public API documentation; unverified. */
class TwilioAdapter implements MessageAdapter {
  provider = "twilio";
  status = "not_configured" as IntegrationStatus;
  available = true;
  constructor(private cfg: Extract<SmsConfig, { provider: "twilio" }>) {}
  private get auth() {
    return `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`;
  }
  private get base() {
    return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}`;
  }
  async send(msg: { to: string; body: string }): Promise<SendResult> {
    const form = new URLSearchParams({ To: `+${msg.to.replace(/^\+/, "")}`, Body: msg.body });
    // A messaging service SID (MG…) lets Twilio pick the sender; otherwise From is a phone number or sender ID.
    if (this.cfg.from.startsWith("MG")) form.set("MessagingServiceSid", this.cfg.from);
    else form.set("From", this.cfg.from);
    const res = await post(`${this.base}/Messages.json`, { method: "POST", headers: { authorization: this.auth, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form }, "SMS provider");
    const json = (await res.json().catch(() => null)) as { sid?: string; status?: string; code?: number; message?: string } | null;
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`SMS provider error ${res.status}`, "SMS_5XX");
    if (res.status === 401) throw new PermanentError("SMS provider rejected the credentials", "SMS_AUTH");
    if (!res.ok || !json?.sid) throw new PermanentError(`SMS not accepted${json?.code ? ` (${json.code})` : ""}`, "SMS_NOT_ACCEPTED");
    if (json.status === "failed" || json.status === "undelivered") throw new PermanentError(`SMS not accepted: ${json.status}`, "SMS_NOT_ACCEPTED");
    return { providerMessageId: json.sid, simulated: false };
  }
  async balance(): Promise<Balance> {
    const res = await post(`${this.base}/Balance.json`, { method: "GET", headers: { authorization: this.auth, accept: "application/json" } }, "SMS provider");
    if (res.status === 401) throw new PermanentError("SMS provider rejected the credentials", "SMS_AUTH");
    if (!res.ok) throw new RetryableError(`SMS provider error ${res.status}`, "SMS_BALANCE");
    const json = (await res.json().catch(() => null)) as { balance?: string; currency?: string } | null;
    if (!json?.balance || !json.currency || !Number.isFinite(Number(json.balance))) throw new PermanentError("The provider did not return a balance", "SMS_BALANCE");
    return { amount: Number(json.balance).toFixed(2), currency: json.currency.toUpperCase() };
  }
}

export function mockAdapter(channel: "SMS" | "EMAIL"): MessageAdapter {
  return new MockAdapter(channel === "SMS" ? "mock-sms" : "mock-email");
}

export function smsAdapterFor(cfg: SmsConfig | null): MessageAdapter {
  if (!cfg) return new NotConfiguredAdapter("sms");
  return cfg.provider === "twilio" ? new TwilioAdapter(cfg) : new AfricasTalkingAdapter(cfg);
}

export function emailAdapterFor(cfg: SmtpConfig | null): MessageAdapter {
  return cfg ? new SmtpAdapter(cfg) : new NotConfiguredAdapter("email");
}

/** Single-tenant configuration from the environment (SMS_PROVIDER=africastalking|twilio, SMTP_*). */
export function envSmsConfig(): SmsConfig | null {
  const e = process.env;
  if (e.SMS_PROVIDER === "africastalking" && e.SMS_API_KEY && e.SMS_USERNAME) return { provider: "africastalking", username: e.SMS_USERNAME, apiKey: e.SMS_API_KEY, senderId: e.SMS_SENDER_ID || null };
  if (e.SMS_PROVIDER === "twilio" && e.SMS_USERNAME && e.SMS_API_KEY && e.SMS_SENDER_ID) return { provider: "twilio", accountSid: e.SMS_USERNAME, authToken: e.SMS_API_KEY, from: e.SMS_SENDER_ID };
  return null;
}

export function envSmtpConfig(): SmtpConfig | null {
  const e = process.env;
  if (!e.SMTP_HOST) return null;
  const port = Number(e.SMTP_PORT ?? 587);
  return { host: e.SMTP_HOST, port, security: port === 465 ? "ssl" : "starttls", username: e.SMTP_USER || null, password: e.SMTP_PASSWORD || null, fromAddress: e.SMTP_FROM || e.SMTP_USER || "", fromName: null };
}

/** Environment-level adapters (deployment default when an organization has not configured its own). */
export function emailAdapter(): MessageAdapter {
  const mode = messagingMode();
  if (mode === "mock") return mockAdapter("EMAIL");
  return mode === "live" ? emailAdapterFor(envSmtpConfig()) : new NotConfiguredAdapter("email");
}

export function smsAdapter(): MessageAdapter {
  const mode = messagingMode();
  if (mode === "mock") return mockAdapter("SMS");
  return mode === "live" ? smsAdapterFor(envSmsConfig()) : new NotConfiguredAdapter("sms");
}

export function messagingStatus() {
  const e = emailAdapter();
  const s = smsAdapter();
  return { email: { provider: e.provider, status: e.status, available: e.available }, sms: { provider: s.provider, status: s.status, available: s.available } };
}
