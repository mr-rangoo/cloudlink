import "server-only";
import { createHash } from "node:crypto";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { logger, maskContact } from "@/server/observability/logger";

/**
 * Messaging adapters (server-side only). Integration status values follow INTEGRATIONS.md.
 * - Mock adapters are deterministic, never contact a provider, and mark messages as simulated.
 * - SMTP email uses nodemailer when SMTP_* is configured (not yet verified against a real server).
 * - SMS supports Africa's Talking when SMS_PROVIDER=africastalking (implemented from public docs; NOT verified).
 * - A missing configuration yields a NotConfigured adapter: messages are SKIPPED, never reported as sent.
 */
export type IntegrationStatus = "not_configured" | "mock" | "sandbox_tested" | "production_verified" | "error";

export interface SendResult {
  providerMessageId: string;
  simulated: boolean;
}

export interface MessageAdapter {
  provider: string;
  status: IntegrationStatus;
  /** False when messages cannot be sent at all (caller records SKIPPED). */
  available: boolean;
  send(msg: { to: string; subject?: string | null; body: string }): Promise<SendResult>;
}

const TIMEOUT_MS = 10_000;

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

class SmtpAdapter implements MessageAdapter {
  provider = "smtp";
  status = "not_configured" as IntegrationStatus; // becomes sandbox_tested/production_verified only after a recorded real test
  available = true;
  async send(msg: { to: string; subject?: string | null; body: string }): Promise<SendResult> {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: Number(process.env.SMTP_PORT ?? 587) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
    try {
      const info = await transport.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to: msg.to, subject: msg.subject ?? "Cloudlink", text: msg.body });
      return { providerMessageId: String(info.messageId ?? ""), simulated: false };
    } catch (err) {
      const code = (err as { code?: string; responseCode?: number }).responseCode;
      if (code && code >= 500) throw new PermanentError("SMTP rejected the message", `SMTP_${code}`);
      throw new RetryableError("SMTP temporarily unavailable", "SMTP_TRANSIENT");
    }
  }
}

/** Africa's Talking bulk SMS (form-encoded POST). Implemented from public API documentation; unverified. */
class AfricasTalkingAdapter implements MessageAdapter {
  provider = "africastalking";
  status = "not_configured" as IntegrationStatus;
  available = true;
  async send(msg: { to: string; body: string }): Promise<SendResult> {
    const sandbox = (process.env.SMS_USERNAME ?? "") === "sandbox";
    const url = sandbox ? "https://api.sandbox.africastalking.com/version1/messaging" : "https://api.africastalking.com/version1/messaging";
    const form = new URLSearchParams({ username: process.env.SMS_USERNAME ?? "", to: `+${msg.to.replace(/^\+/, "")}`, message: msg.body });
    if (process.env.SMS_SENDER_ID) form.set("from", process.env.SMS_SENDER_ID);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { apiKey: process.env.SMS_API_KEY ?? "", accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new RetryableError("SMS provider unreachable", "SMS_TIMEOUT");
    }
    if (res.status >= 500) throw new RetryableError(`SMS provider error ${res.status}`, "SMS_5XX");
    if (!res.ok) throw new PermanentError(`SMS provider rejected the request (${res.status})`, "SMS_REJECTED");
    const json = (await res.json().catch(() => null)) as { SMSMessageData?: { Recipients?: Array<{ statusCode?: number; messageId?: string; status?: string }> } } | null;
    const r = json?.SMSMessageData?.Recipients?.[0];
    if (!r || (r.statusCode !== 100 && r.statusCode !== 101 && r.statusCode !== 102)) throw new PermanentError(`SMS not accepted: ${r?.status ?? "unknown"}`, "SMS_NOT_ACCEPTED");
    return { providerMessageId: r.messageId ?? "", simulated: false };
  }
}

export function emailAdapter(): MessageAdapter {
  const mode = process.env.MESSAGING_ADAPTER ?? "mock";
  if (mode === "mock") return new MockAdapter("mock-email");
  if (mode === "smtp" && process.env.SMTP_HOST) return new SmtpAdapter();
  return new NotConfiguredAdapter("email");
}

export function smsAdapter(): MessageAdapter {
  const mode = process.env.MESSAGING_ADAPTER ?? "mock";
  if (mode === "mock") return new MockAdapter("mock-sms");
  if (process.env.SMS_PROVIDER === "africastalking" && process.env.SMS_API_KEY && process.env.SMS_USERNAME) return new AfricasTalkingAdapter();
  return new NotConfiguredAdapter("sms");
}

export function messagingStatus() {
  const e = emailAdapter();
  const s = smsAdapter();
  return { email: { provider: e.provider, status: e.status, available: e.available }, sms: { provider: s.provider, status: s.status, available: s.available } };
}
