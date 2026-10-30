import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/server/errors";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "@/server/security/crypto";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { DarajaGateway, type DarajaConfig } from "@/server/integrations/payments/daraja";
import { MockGateway } from "@/server/integrations/payments/mock";
import type { GatewayProvider, PaymentGateway } from "@/server/integrations/payments/gateway";
import { KopoKopoGateway } from "@/server/integrations/payments/kopokopo";
import { activeGatewayKey, kopokopoConfigFor, recordGatewayVerified } from "@/server/services/payment-gateways";
import type { Prisma } from "@/generated/prisma/client";

/**
 * M-Pesa configuration per organization (each ISP has its own paybill/till and Daraja app).
 * - Credentials are stored AES-256-GCM encrypted in IntegrationConfiguration (AAD bound to organization + provider)
 *   and are write-only through the API.
 * - Single-tenant deployments may instead use the MPESA_* environment variables for the organization named in
 *   MPESA_ENV_ORGANIZATION.
 * - PAYMENT_ADAPTER=mock uses the mock gateway; PAYMENT_ADAPTER=disabled makes online payment unavailable.
 */
const PROVIDER = "mpesa_daraja";
const aad = (organizationId: string) => `integration:${organizationId}:${PROVIDER}`;

interface SafeConfig {
  environment: "sandbox" | "production";
  type: "PAYBILL" | "TILL";
  shortcode: string;
  tillNumber: string | null;
  rejectUnknownAccounts: boolean;
  c2bTokenHash?: string;
  c2bRegisteredAt?: string;
}

interface SecretConfig {
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  c2bToken?: string;
}

export interface ResolvedGateway {
  gateway: PaymentGateway;
  provider: GatewayProvider;
  environment: "sandbox" | "production" | "mock";
  /** Paybill/store number (Daraja) or till number (Kopo Kopo). */
  shortcode: string;
  source: "integration" | "environment" | "mock";
  /** Webhook path segment for this provider's result callbacks. */
  callbackPath: "stk" | "kopokopo";
}

export function callbackBaseUrl(): string {
  return (process.env.MPESA_CALLBACK_URL || process.env.APP_URL || "").replace(/\/$/, "");
}

/** mock (development default), daraja = real gateways ("live" is accepted as the same), disabled. */
export function paymentAdapterMode(): "mock" | "daraja" | "disabled" {
  const mode = process.env.PAYMENT_ADAPTER || "mock";
  if (mode === "live") return "daraja";
  return mode === "mock" || mode === "daraja" ? mode : "disabled";
}

function envConfig(): DarajaConfig | null {
  const e = process.env;
  if (!e.MPESA_CONSUMER_KEY || !e.MPESA_CONSUMER_SECRET || !e.MPESA_PASSKEY || !e.MPESA_SHORTCODE) return null;
  return {
    environment: e.MPESA_ENVIRONMENT === "production" ? "production" : "sandbox",
    consumerKey: e.MPESA_CONSUMER_KEY,
    consumerSecret: e.MPESA_CONSUMER_SECRET,
    passkey: e.MPESA_PASSKEY,
    shortcode: e.MPESA_SHORTCODE,
    type: e.MPESA_SHORTCODE_TYPE === "TILL" ? "TILL" : "PAYBILL",
    tillNumber: e.MPESA_TILL_NUMBER || null,
  };
}

async function loadStored(organizationId: string) {
  const row = await db.integrationConfiguration.findUnique({ where: { organizationId_provider: { organizationId, provider: PROVIDER } } });
  if (!row) return null;
  const safe = (row.safeConfig ?? null) as SafeConfig | null;
  let secret: SecretConfig | null = null;
  if (row.encryptedSecret) {
    try {
      secret = JSON.parse(decryptSecret(row.encryptedSecret, aad(organizationId))) as SecretConfig;
    } catch {
      throw new PermanentError("Stored M-Pesa credentials could not be decrypted (APP_ENCRYPTION_KEY changed?)", "MPESA_CONFIG_UNREADABLE");
    }
  }
  return { row, safe, secret };
}

/** Daraja configuration for an organization, or null when none is available. */
export async function darajaConfigFor(organizationId: string): Promise<{ config: DarajaConfig; source: "integration" | "environment" } | null> {
  const stored = await loadStored(organizationId);
  if (stored?.safe?.shortcode && stored.secret?.consumerKey) {
    return {
      source: "integration",
      config: { environment: stored.safe.environment, type: stored.safe.type, shortcode: stored.safe.shortcode, tillNumber: stored.safe.tillNumber, consumerKey: stored.secret.consumerKey, consumerSecret: stored.secret.consumerSecret, passkey: stored.secret.passkey },
    };
  }
  const slug = process.env.MPESA_ENV_ORGANIZATION;
  const env = envConfig();
  if (slug && env) {
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { slug: true } });
    if (org?.slug === slug) return { source: "environment", config: env };
  }
  return null;
}

/** The gateway for NEW online payments (the organization's active gateway). Throws INTEGRATION_UNAVAILABLE with a customer-safe message. */
export async function resolveGateway(organizationId: string): Promise<ResolvedGateway> {
  const mode = paymentAdapterMode();
  if (mode === "disabled") throw new AppError("INTEGRATION_UNAVAILABLE", "Online payment is not available. Please pay using your account number.");
  if (mode === "mock") return gatewayFor(organizationId, "mock");
  return gatewayFor(organizationId, await activeGatewayKey(organizationId));
}

/**
 * The gateway of a given provider: used to verify and query requests with the provider that sent them, even if
 * the organization has since switched its active gateway.
 */
export async function gatewayFor(organizationId: string, provider: GatewayProvider | string): Promise<ResolvedGateway> {
  if (provider === "mock") {
    if (process.env.APP_ENV === "production") throw new AppError("INTEGRATION_UNAVAILABLE", "Simulated payment requests cannot be processed in production.");
    return { gateway: new MockGateway(), provider: "mock", environment: "mock", shortcode: "000000", source: "mock", callbackPath: "stk" };
  }
  if (provider === "kopokopo") {
    const cfg = await kopokopoConfigFor(organizationId);
    if (!cfg) throw new AppError("INTEGRATION_UNAVAILABLE", "Online payment is not set up for this provider yet. Please pay using your account number.");
    return { gateway: new KopoKopoGateway(cfg), provider: "kopokopo", environment: cfg.environment, shortcode: cfg.tillNumber, source: "integration", callbackPath: "kopokopo" };
  }
  if (provider !== PROVIDER) throw new AppError("INTEGRATION_UNAVAILABLE", "Unknown payment gateway.");
  const found = await darajaConfigFor(organizationId);
  if (!found) throw new AppError("INTEGRATION_UNAVAILABLE", "M-Pesa is not configured for this provider yet. Please pay using your account number.");
  return { gateway: new DarajaGateway(found.config), provider: "mpesa_daraja", environment: found.config.environment, shortcode: found.config.shortcode, source: found.source, callbackPath: "stk" };
}

// ───────── Staff configuration ─────────

const digits = (min: number, max: number) => z.string().trim().regex(new RegExp(`^\\d{${min},${max}}$`), `Use ${min}–${max} digits`);
const secretField = z.string().trim().min(8).max(300);

export const mpesaConfigInput = z
  .object({
    environment: z.enum(["sandbox", "production"]),
    type: z.enum(["PAYBILL", "TILL"]),
    shortcode: digits(5, 7),
    tillNumber: digits(5, 8).optional().nullable().or(z.literal("").transform(() => null)),
    consumerKey: secretField.optional(),
    consumerSecret: secretField.optional(),
    passkey: secretField.optional(),
    rejectUnknownAccounts: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.type === "TILL" && !v.tillNumber) ctx.addIssue({ code: "custom", path: ["tillNumber"], message: "Enter the till number customers pay to." });
    const given = [v.consumerKey, v.consumerSecret, v.passkey].filter(Boolean).length;
    if (given !== 0 && given !== 3) ctx.addIssue({ code: "custom", path: ["passkey"], message: "Enter the consumer key, consumer secret and passkey together." });
  });

export async function getMpesaSettings(ctx: StaffContext) {
  requirePermission(ctx, "integrations.read");
  const stored = await loadStored(ctx.organizationId);
  const env = await darajaConfigFor(ctx.organizationId);
  const canWrite = ctx.permissions.has("integrations.write");
  const base = callbackBaseUrl();
  const c2bToken = canWrite ? stored?.secret?.c2bToken : undefined;
  return {
    mode: paymentAdapterMode(),
    source: env?.source ?? null,
    environment: stored?.safe?.environment ?? env?.config.environment ?? null,
    type: stored?.safe?.type ?? env?.config.type ?? null,
    shortcode: stored?.safe?.shortcode ?? env?.config.shortcode ?? null,
    tillNumber: stored?.safe?.tillNumber ?? env?.config.tillNumber ?? null,
    rejectUnknownAccounts: stored?.safe?.rejectUnknownAccounts ?? false,
    credentialsSet: Boolean(env),
    status: stored?.row.status ?? "NOT_CONFIGURED",
    lastCheckedAt: stored?.row.lastCheckedAt ?? null,
    lastError: stored?.row.lastError ?? null,
    c2bRegisteredAt: stored?.safe?.c2bRegisteredAt ?? null,
    // The C2B URLs contain a secret token: only shown to staff who can configure integrations.
    c2bUrls: c2bToken ? { confirmationUrl: `${base}/api/v1/webhooks/mobile-money/c2b/${c2bToken}/confirmation`, validationUrl: `${base}/api/v1/webhooks/mobile-money/c2b/${c2bToken}/validation` } : null,
    callbackBase: base,
  };
}

export async function saveMpesaSettings(ctx: StaffContext, raw: z.input<typeof mpesaConfigInput>) {
  requirePermission(ctx, "integrations.write");
  const input = mpesaConfigInput.parse(raw);
  const stored = await loadStored(ctx.organizationId);
  const secretGiven = Boolean(input.consumerKey && input.consumerSecret && input.passkey);
  if (!secretGiven && !stored?.secret) throw new AppError("VALIDATION_ERROR", "Enter the Daraja consumer key, consumer secret and passkey.", { fields: [{ path: "consumerKey", message: "Required" }] });
  const secret: SecretConfig = secretGiven
    ? { consumerKey: input.consumerKey!, consumerSecret: input.consumerSecret!, passkey: input.passkey!, c2bToken: stored?.secret?.c2bToken }
    : stored!.secret!;
  const prev = stored?.safe;
  const safe: SafeConfig = {
    environment: input.environment,
    type: input.type,
    shortcode: input.shortcode,
    tillNumber: input.type === "TILL" ? (input.tillNumber ?? null) : null,
    rejectUnknownAccounts: input.rejectUnknownAccounts,
    ...(prev?.c2bTokenHash ? { c2bTokenHash: prev.c2bTokenHash } : {}),
    ...(prev?.c2bRegisteredAt && prev.shortcode === input.shortcode ? { c2bRegisteredAt: prev.c2bRegisteredAt } : {}),
  };
  // Changing where money goes or which credentials are used invalidates any earlier verification.
  const materialChange = !prev || prev.environment !== safe.environment || prev.shortcode !== safe.shortcode || prev.type !== safe.type || prev.tillNumber !== safe.tillNumber || secretGiven;
  await db.integrationConfiguration.upsert({
    where: { organizationId_provider: { organizationId: ctx.organizationId, provider: PROVIDER } },
    create: { organizationId: ctx.organizationId, provider: PROVIDER, status: "NOT_CONFIGURED", safeConfig: safe as unknown as Prisma.InputJsonValue, encryptedSecret: encryptSecret(JSON.stringify(secret), aad(ctx.organizationId)) },
    update: {
      safeConfig: safe as unknown as Prisma.InputJsonValue,
      encryptedSecret: encryptSecret(JSON.stringify(secret), aad(ctx.organizationId)),
      ...(materialChange ? { status: "NOT_CONFIGURED", lastError: null } : {}),
    },
  });
  await audit(ctx, {
    action: "integration.mpesa.configure",
    entityType: "integration",
    entityId: PROVIDER,
    metadata: { environment: safe.environment, type: safe.type, shortcode: safe.shortcode, tillNumber: safe.tillNumber, credentialsReplaced: secretGiven, verificationReset: materialChange },
  });
  return getMpesaSettings(ctx);
}

async function recordCheck(organizationId: string, error: string | null) {
  await db.integrationConfiguration.upsert({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    create: { organizationId, provider: PROVIDER, status: error ? "ERROR" : "NOT_CONFIGURED", lastCheckedAt: new Date(), lastError: error },
    update: { lastCheckedAt: new Date(), lastError: error, ...(error ? { status: "ERROR" } : {}) },
  });
}

/** Fetch an OAuth token to prove the credentials work. Does not move money and does not mark the integration verified. */
export async function testMpesaCredentials(ctx: StaffContext) {
  requirePermission(ctx, "integrations.write");
  if (paymentAdapterMode() !== "daraja") throw new AppError("INTEGRATION_UNAVAILABLE", "Set PAYMENT_ADAPTER=daraja to test M-Pesa credentials.");
  const found = await darajaConfigFor(ctx.organizationId);
  if (!found) throw new AppError("INTEGRATION_UNAVAILABLE", "Save the M-Pesa credentials first.");
  let error: string | null = null;
  try {
    await new DarajaGateway(found.config).testCredentials();
  } catch (err) {
    error = err instanceof PermanentError || err instanceof RetryableError ? err.message : "Credential test failed";
  }
  await recordCheck(ctx.organizationId, error);
  await audit(ctx, { action: "integration.mpesa.test", entityType: "integration", entityId: PROVIDER, metadata: { ok: !error } });
  return { ok: !error, error };
}

/** Register C2B URLs (with a fresh secret token) so payments made directly to the paybill/till are reported. */
export async function registerC2bUrls(ctx: StaffContext) {
  requirePermission(ctx, "integrations.write");
  if (paymentAdapterMode() !== "daraja") throw new AppError("INTEGRATION_UNAVAILABLE", "Set PAYMENT_ADAPTER=daraja to register C2B URLs.");
  const found = await darajaConfigFor(ctx.organizationId);
  if (!found) throw new AppError("INTEGRATION_UNAVAILABLE", "Save the M-Pesa credentials first.");
  const base = callbackBaseUrl();
  if (!base.startsWith("https://") && process.env.APP_ENV === "production") throw new AppError("INVALID_STATE", "The public callback URL must use HTTPS.");
  const token = randomToken(24);
  const urls = { confirmationUrl: `${base}/api/v1/webhooks/mobile-money/c2b/${token}/confirmation`, validationUrl: `${base}/api/v1/webhooks/mobile-money/c2b/${token}/validation` };
  let error: string | null = null;
  try {
    await new DarajaGateway(found.config).registerC2bUrls(urls);
  } catch (err) {
    error = err instanceof PermanentError || err instanceof RetryableError ? err.message : "Registration failed";
  }
  if (!error) {
    const stored = await loadStored(ctx.organizationId);
    const safe: SafeConfig = {
      ...(stored?.safe ?? { environment: found.config.environment, type: found.config.type, shortcode: found.config.shortcode, tillNumber: found.config.tillNumber ?? null, rejectUnknownAccounts: false }),
      c2bTokenHash: sha256(token),
      c2bRegisteredAt: new Date().toISOString(),
    };
    const secret: SecretConfig = { ...(stored?.secret ?? { consumerKey: "", consumerSecret: "", passkey: "" }), c2bToken: token };
    await db.integrationConfiguration.upsert({
      where: { organizationId_provider: { organizationId: ctx.organizationId, provider: PROVIDER } },
      create: { organizationId: ctx.organizationId, provider: PROVIDER, safeConfig: safe as unknown as Prisma.InputJsonValue, encryptedSecret: encryptSecret(JSON.stringify(secret), aad(ctx.organizationId)), lastCheckedAt: new Date() },
      update: { safeConfig: safe as unknown as Prisma.InputJsonValue, encryptedSecret: encryptSecret(JSON.stringify(secret), aad(ctx.organizationId)), lastCheckedAt: new Date(), lastError: null },
    });
  } else {
    await recordCheck(ctx.organizationId, error);
  }
  await audit(ctx, { action: "integration.mpesa.register_c2b", entityType: "integration", entityId: PROVIDER, metadata: { ok: !error } });
  if (error) throw new AppError("INTEGRATION_ERROR", error);
  return getMpesaSettings(ctx);
}

/** Webhook side: find the organization whose C2B token this is. */
export async function c2bConfigForToken(token: string) {
  const row = await db.integrationConfiguration.findFirst({ where: { provider: PROVIDER, safeConfig: { path: ["c2bTokenHash"], equals: sha256(token) } } });
  if (!row) return null;
  const safe = row.safeConfig as unknown as SafeConfig;
  return { organizationId: row.organizationId, shortcode: safe.shortcode, tillNumber: safe.tillNumber, type: safe.type, rejectUnknownAccounts: safe.rejectUnknownAccounts };
}

/** Record real evidence: the first confirmed sandbox/production payment marks the integration tested/verified. */
export async function recordVerifiedPayment(organizationId: string, environment: "sandbox" | "production" | "mock", provider: string = PROVIDER) {
  await recordGatewayVerified(organizationId, provider, environment);
}
