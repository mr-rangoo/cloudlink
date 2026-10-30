import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/server/errors";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { normalizePhone } from "@/server/domain/contact";
import { maskContact } from "@/server/observability/logger";
import {
  emailAdapterFor,
  envSmsConfig,
  envSmtpConfig,
  messagingMode,
  mockAdapter,
  smsAdapterFor,
  type Balance,
  type MessageAdapter,
  type SmsConfig,
  type SmtpConfig,
} from "@/server/integrations/messaging";
import type { Prisma } from "@/generated/prisma/client";

/**
 * SMS and email providers per organization, stored in IntegrationConfiguration (provider "sms" / "email"):
 * non-secret settings in safeConfig, the API key / token / password AES-256-GCM encrypted (write-only).
 * Status: NOT_CONFIGURED until a test message is accepted by the provider AND a staff member confirms it arrived
 * (then SANDBOX_TESTED for the Africa's Talking sandbox, PRODUCTION_VERIFIED otherwise). Changing the provider,
 * credentials, sender or server resets the status.
 */
export type Channel = "SMS" | "EMAIL";
const KEY: Record<Channel, string> = { SMS: "sms", EMAIL: "email" };
const aad = (organizationId: string, channel: Channel) => `integration:${organizationId}:messaging:${KEY[channel]}`;

interface TestRecord {
  at: string;
  to: string;
  accepted: boolean;
  simulated: boolean;
  providerMessageId?: string;
  error?: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

interface SmsSafe {
  provider: "africastalking" | "twilio";
  username?: string;
  senderId?: string | null;
  accountSid?: string;
  from?: string;
  enabled: boolean;
  lastTest?: TestRecord;
  lastBalance?: Balance & { at: string };
}

interface EmailSafe {
  host: string;
  port: number;
  security: SmtpConfig["security"];
  username: string | null;
  fromAddress: string;
  fromName: string | null;
  enabled: boolean;
  lastTest?: TestRecord;
}

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, "Enter the mail server's host name, e.g. smtp.example.com");
const optionalText = (max: number) => z.union([z.string().trim().max(max), z.literal("")]).optional().nullable().transform((v) => (v ? v : null));

export const smsSettingsInput = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("africastalking"),
    username: z.string().trim().min(2).max(100),
    senderId: optionalText(11),
    apiKey: z.string().trim().min(10).max(200).optional(),
    enabled: z.boolean().default(true),
  }),
  z.object({
    provider: z.literal("twilio"),
    accountSid: z.string().trim().regex(/^AC[0-9a-f]{32}$/, "Twilio account SIDs start with AC followed by 32 characters"),
    from: z.string().trim().regex(/^(\+\d{8,15}|MG[0-9a-f]{32}|[A-Za-z0-9]{1,11})$/, "A phone number (+254…), a messaging service SID (MG…) or a sender ID of up to 11 letters/digits"),
    authToken: z.string().trim().min(16).max(200).optional(),
    enabled: z.boolean().default(true),
  }),
]);

export const emailSettingsInput = z.object({
  host: hostname,
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(["ssl", "starttls", "none"]),
  username: optionalText(200),
  password: z.string().min(1).max(300).optional(),
  fromAddress: z.email("Enter the address messages come from"),
  fromName: optionalText(100),
  enabled: z.boolean().default(true),
});

export const testMessageInput = z.object({ channel: z.enum(["SMS", "EMAIL"]), to: z.string().trim().min(3).max(200) });

async function load<T>(organizationId: string, channel: Channel) {
  const row = await db.integrationConfiguration.findUnique({ where: { organizationId_provider: { organizationId, provider: KEY[channel] } } });
  if (!row) return null;
  let secret: Record<string, string> | null = null;
  if (row.encryptedSecret) {
    try {
      secret = JSON.parse(decryptSecret(row.encryptedSecret, aad(organizationId, channel))) as Record<string, string>;
    } catch {
      throw new PermanentError("Stored messaging credentials could not be decrypted (APP_ENCRYPTION_KEY changed?)", "MESSAGING_CONFIG_UNREADABLE");
    }
  }
  return { row, safe: (row.safeConfig ?? null) as T | null, secret };
}

function smsConfigOf(safe: SmsSafe | null, secret: Record<string, string> | null): SmsConfig | null {
  if (!safe?.enabled || !secret) return null;
  if (safe.provider === "africastalking" && safe.username && secret.apiKey) return { provider: "africastalking", username: safe.username, apiKey: secret.apiKey, senderId: safe.senderId ?? null };
  if (safe.provider === "twilio" && safe.accountSid && safe.from && secret.authToken) return { provider: "twilio", accountSid: safe.accountSid, authToken: secret.authToken, from: safe.from };
  return null;
}

function smtpConfigOf(safe: EmailSafe | null, secret: Record<string, string> | null): SmtpConfig | null {
  if (!safe?.enabled) return null;
  return { host: safe.host, port: safe.port, security: safe.security, username: safe.username, password: secret?.password ?? null, fromAddress: safe.fromAddress, fromName: safe.fromName };
}

/**
 * The adapter that delivers an organization's messages: mock in development, otherwise the organization's own
 * provider, else the deployment's environment configuration, else "not configured" (messages are skipped).
 */
export async function messagingAdapterForOrg(organizationId: string, channel: Channel): Promise<{ adapter: MessageAdapter; source: "mock" | "integration" | "environment" | "none" }> {
  const mode = messagingMode();
  if (mode === "mock") return { adapter: mockAdapter(channel), source: "mock" };
  if (mode === "disabled") return { adapter: channel === "SMS" ? smsAdapterFor(null) : emailAdapterFor(null), source: "none" };
  if (channel === "SMS") {
    const stored = await load<SmsSafe>(organizationId, "SMS");
    const own = smsConfigOf(stored?.safe ?? null, stored?.secret ?? null);
    if (own) return { adapter: smsAdapterFor(own), source: "integration" };
    const env = envSmsConfig();
    return env ? { adapter: smsAdapterFor(env), source: "environment" } : { adapter: smsAdapterFor(null), source: "none" };
  }
  const stored = await load<EmailSafe>(organizationId, "EMAIL");
  const own = smtpConfigOf(stored?.safe ?? null, stored?.secret ?? null);
  if (own) return { adapter: emailAdapterFor(own), source: "integration" };
  const env = envSmtpConfig();
  return env ? { adapter: emailAdapterFor(env), source: "environment" } : { adapter: emailAdapterFor(null), source: "none" };
}

const STATUS_OF: Record<string, string> = { NOT_CONFIGURED: "configured", SANDBOX_TESTED: "sandbox_tested", PRODUCTION_VERIFIED: "production_verified", ERROR: "error" };

/** What delivers each channel for an organization right now, with its verification state (callers check permissions). */
export async function messagingInUse(organizationId: string) {
  const [sms, email, rows] = await Promise.all([
    messagingAdapterForOrg(organizationId, "SMS"),
    messagingAdapterForOrg(organizationId, "EMAIL"),
    db.integrationConfiguration.findMany({ where: { organizationId, provider: { in: ["sms", "email"] } }, select: { provider: true, status: true } }),
  ]);
  const view = (u: { adapter: MessageAdapter; source: string }, key: string) => ({
    provider: u.adapter.provider,
    source: u.source,
    available: u.adapter.available,
    status: u.source === "mock" ? "mock" : !u.adapter.available ? "not_configured" : u.source === "integration" ? (STATUS_OF[rows.find((r) => r.provider === key)?.status ?? "NOT_CONFIGURED"] ?? "configured") : "configured",
  });
  return { sms: view(sms, "sms"), email: view(email, "email") };
}

// ───────── Staff settings ─────────

function testView(t: TestRecord | undefined) {
  return t ? { at: t.at, to: t.to, accepted: t.accepted, simulated: t.simulated, error: t.error ?? null, confirmedAt: t.confirmedAt ?? null } : null;
}

export async function getMessagingSettings(ctx: StaffContext) {
  requirePermission(ctx, "integrations.read");
  const [sms, email, smsUse, emailUse] = await Promise.all([
    load<SmsSafe>(ctx.organizationId, "SMS"),
    load<EmailSafe>(ctx.organizationId, "EMAIL"),
    messagingAdapterForOrg(ctx.organizationId, "SMS"),
    messagingAdapterForOrg(ctx.organizationId, "EMAIL"),
  ]);
  const s = sms?.safe;
  const e = email?.safe;
  return {
    mode: messagingMode(),
    sms: {
      inUse: { provider: smsUse.adapter.provider, source: smsUse.source, available: smsUse.adapter.available },
      provider: s?.provider ?? null,
      username: s?.username ?? null,
      senderId: s?.senderId ?? null,
      accountSid: s?.accountSid ?? null,
      from: s?.from ?? null,
      enabled: s?.enabled ?? false,
      credentialsSet: Boolean(sms?.secret && (sms.secret.apiKey || sms.secret.authToken)),
      status: sms?.row.status ?? "NOT_CONFIGURED",
      lastTest: testView(s?.lastTest),
      lastBalance: s?.lastBalance ?? null,
      balanceSupported: Boolean(smsUse.adapter.balance),
    },
    email: {
      inUse: { provider: emailUse.adapter.provider, source: emailUse.source, available: emailUse.adapter.available },
      host: e?.host ?? null,
      port: e?.port ?? null,
      security: e?.security ?? null,
      username: e?.username ?? null,
      fromAddress: e?.fromAddress ?? null,
      fromName: e?.fromName ?? null,
      enabled: e?.enabled ?? false,
      passwordSet: Boolean(email?.secret?.password),
      status: email?.row.status ?? "NOT_CONFIGURED",
      lastTest: testView(e?.lastTest),
    },
  };
}

async function upsert(organizationId: string, channel: Channel, safe: object, secret: Record<string, string> | null, resetStatus: boolean) {
  await db.integrationConfiguration.upsert({
    where: { organizationId_provider: { organizationId, provider: KEY[channel] } },
    create: { organizationId, provider: KEY[channel], status: "NOT_CONFIGURED", safeConfig: safe as Prisma.InputJsonValue, encryptedSecret: secret ? encryptSecret(JSON.stringify(secret), aad(organizationId, channel)) : null },
    update: {
      safeConfig: safe as Prisma.InputJsonValue,
      ...(secret ? { encryptedSecret: encryptSecret(JSON.stringify(secret), aad(organizationId, channel)) } : {}),
      ...(resetStatus ? { status: "NOT_CONFIGURED", lastError: null } : {}),
    },
  });
}

export async function saveSmsSettings(ctx: StaffContext, raw: z.input<typeof smsSettingsInput>) {
  requirePermission(ctx, "integrations.write");
  const input = smsSettingsInput.parse(raw);
  const stored = await load<SmsSafe>(ctx.organizationId, "SMS");
  const prev = stored?.safe ?? null;
  const newSecret = input.provider === "africastalking" ? input.apiKey : input.authToken;
  const sameProvider = prev?.provider === input.provider && Boolean(stored?.secret);
  if (!newSecret && !sameProvider) {
    const field = input.provider === "africastalking" ? "apiKey" : "authToken";
    throw new AppError("VALIDATION_ERROR", "Enter the provider's API key or auth token.", { fields: [{ path: field, message: "Required" }] });
  }
  const secret: Record<string, string> | null = newSecret ? (input.provider === "africastalking" ? { apiKey: newSecret } : { authToken: newSecret }) : null;
  const safe: SmsSafe =
    input.provider === "africastalking"
      ? { provider: "africastalking", username: input.username, senderId: input.senderId, enabled: input.enabled }
      : { provider: "twilio", accountSid: input.accountSid, from: input.from, enabled: input.enabled };
  const material = !prev || prev.provider !== safe.provider || prev.username !== safe.username || prev.senderId !== safe.senderId || prev.accountSid !== safe.accountSid || prev.from !== safe.from || Boolean(secret);
  if (!material) Object.assign(safe, { lastTest: prev?.lastTest, lastBalance: prev?.lastBalance });
  await upsert(ctx.organizationId, "SMS", safe, secret, material);
  await audit(ctx, { action: "integration.sms.configure", entityType: "integration", entityId: "sms", metadata: { provider: safe.provider, senderId: safe.senderId ?? safe.from ?? null, enabled: safe.enabled, credentialsReplaced: Boolean(secret), verificationReset: material } });
  return getMessagingSettings(ctx);
}

export async function saveEmailSettings(ctx: StaffContext, raw: z.input<typeof emailSettingsInput>) {
  requirePermission(ctx, "integrations.write");
  const input = emailSettingsInput.parse(raw);
  if (input.security === "none" && process.env.APP_ENV === "production") {
    throw new AppError("VALIDATION_ERROR", "Unencrypted SMTP is not allowed in production.", { fields: [{ path: "security", message: "Use SSL or STARTTLS" }] });
  }
  const stored = await load<EmailSafe>(ctx.organizationId, "EMAIL");
  const prev = stored?.safe ?? null;
  const safe: EmailSafe = { host: input.host, port: input.port, security: input.security, username: input.username, fromAddress: input.fromAddress, fromName: input.fromName, enabled: input.enabled };
  // No username = no login; a stored password is then dropped.
  const secret: Record<string, string> | null = input.password ? { password: input.password } : input.username ? null : {};
  const material = !prev || prev.host !== safe.host || prev.port !== safe.port || prev.security !== safe.security || prev.username !== safe.username || prev.fromAddress !== safe.fromAddress || Boolean(input.password);
  if (!material) Object.assign(safe, { lastTest: prev?.lastTest });
  await upsert(ctx.organizationId, "EMAIL", safe, secret, material);
  await audit(ctx, { action: "integration.email.configure", entityType: "integration", entityId: "email", metadata: { host: safe.host, port: safe.port, security: safe.security, fromAddress: safe.fromAddress, enabled: safe.enabled, passwordReplaced: Boolean(input.password), verificationReset: material } });
  return getMessagingSettings(ctx);
}

/**
 * Send one test message now through the organization's provider and record the outcome. "Accepted" is the
 * provider's answer, not delivery; staff confirm arrival separately.
 */
export async function sendTestMessage(ctx: StaffContext, raw: z.input<typeof testMessageInput>) {
  requirePermission(ctx, "integrations.write");
  const input = testMessageInput.parse(raw);
  const to = input.channel === "SMS" ? normalizePhone(input.to) : z.email().safeParse(input.to).success ? input.to.toLowerCase() : null;
  if (!to) throw new AppError("VALIDATION_ERROR", input.channel === "SMS" ? "Enter a Kenyan mobile number." : "Enter an email address.", { fields: [{ path: "to", message: "Invalid" }] });
  const { adapter, source } = await messagingAdapterForOrg(ctx.organizationId, input.channel);
  if (!adapter.available) throw new AppError("INVALID_STATE", `No ${input.channel === "SMS" ? "SMS" : "email"} provider is configured.`);
  const body = `${ctx.organization.name}: Cloudlink test message sent ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. If you received it, mark the test as received.`;
  let record: TestRecord;
  try {
    const r = await adapter.send({ to, subject: `${ctx.organization.name}: Cloudlink test message`, body });
    record = { at: new Date().toISOString(), to: maskContact(to), accepted: true, simulated: r.simulated, providerMessageId: r.providerMessageId };
  } catch (err) {
    const message = err instanceof PermanentError || err instanceof RetryableError ? err.message : "The provider could not be reached";
    record = { at: new Date().toISOString(), to: maskContact(to), accepted: false, simulated: false, error: message.slice(0, 200) };
  }
  if (source === "integration") {
    const stored = await load<SmsSafe | EmailSafe>(ctx.organizationId, input.channel);
    if (stored?.safe) {
      await db.integrationConfiguration.update({
        where: { id: stored.row.id },
        data: { safeConfig: { ...stored.safe, lastTest: record } as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date(), lastError: record.accepted ? null : (record.error ?? null) },
      });
    }
  }
  await audit(ctx, { action: "integration.messaging.test", entityType: "integration", entityId: KEY[input.channel], metadata: { to: record.to, accepted: record.accepted, simulated: record.simulated, source, error: record.error ?? null } });
  return { ...testView(record)!, source, provider: adapter.provider };
}

/** Staff confirm the test message arrived: the only step that marks a messaging provider as verified. */
export async function confirmTestReceived(ctx: StaffContext, channel: Channel) {
  requirePermission(ctx, "integrations.write");
  const stored = await load<SmsSafe | EmailSafe>(ctx.organizationId, channel);
  const test = stored?.safe?.lastTest;
  if (!stored?.safe || !test?.accepted || test.simulated) throw new AppError("INVALID_STATE", "Send a test message through your own provider first; it must be accepted.");
  const sandbox = channel === "SMS" && (stored.safe as SmsSafe).provider === "africastalking" && (stored.safe as SmsSafe).username === "sandbox";
  const confirmed: TestRecord = { ...test, confirmedAt: new Date().toISOString(), confirmedBy: ctx.userId };
  await db.integrationConfiguration.update({
    where: { id: stored.row.id },
    data: { status: sandbox ? "SANDBOX_TESTED" : "PRODUCTION_VERIFIED", safeConfig: { ...stored.safe, lastTest: confirmed } as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date(), lastError: null },
  });
  await audit(ctx, { action: "integration.messaging.confirm", entityType: "integration", entityId: KEY[channel], metadata: { sandbox, testAt: test.at } });
  return getMessagingSettings(ctx);
}

/** Ask the SMS provider for the prepaid balance (where supported) and remember the answer. */
export async function checkSmsBalance(ctx: StaffContext) {
  requirePermission(ctx, "integrations.read");
  const { adapter, source } = await messagingAdapterForOrg(ctx.organizationId, "SMS");
  if (!adapter.balance) throw new AppError("INVALID_STATE", adapter.available ? "This SMS provider does not report a balance." : "No SMS provider is configured.");
  let balance: Balance;
  try {
    balance = await adapter.balance();
  } catch (err) {
    throw new AppError("INTEGRATION_UNAVAILABLE", err instanceof PermanentError || err instanceof RetryableError ? err.message : "The provider could not be reached.");
  }
  const at = new Date().toISOString();
  if (source === "integration") {
    const stored = await load<SmsSafe>(ctx.organizationId, "SMS");
    if (stored?.safe) await db.integrationConfiguration.update({ where: { id: stored.row.id }, data: { safeConfig: { ...stored.safe, lastBalance: { ...balance, at } } as unknown as Prisma.InputJsonValue } });
  }
  return { ...balance, at, source };
}
