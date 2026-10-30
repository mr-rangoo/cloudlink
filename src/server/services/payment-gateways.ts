import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/server/errors";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { KopoKopoGateway, type KopoKopoConfig } from "@/server/integrations/payments/kopokopo";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Payment gateway catalogue. An organization can configure several gateways but exactly one collects online
 * payments (portal "Pay with M-Pesa", staff payment requests, hotspot sales). Requests already sent keep being
 * verified and confirmed by the gateway that sent them, whatever is active later.
 */
export const GATEWAYS = [
  {
    key: "mpesa_daraja",
    name: "M-Pesa Daraja",
    summary: "Your own Safaricom Paybill or Till through the Daraja API: payment prompts (STK Push) and automatic matching of payments made directly to the paybill/till (C2B).",
    features: ["Payment prompts", "Direct paybill/till payments matched automatically"],
  },
  {
    key: "kopokopo",
    name: "Kopo Kopo (K2 Connect)",
    summary: "M-Pesa payment prompts (STK Push) into your Kopo Kopo till. Payments made directly to the till are recorded from Reconciliation.",
    features: ["Payment prompts"],
  },
] as const;
export type GatewayKey = (typeof GATEWAYS)[number]["key"];

const K2 = "kopokopo";
const k2Aad = (organizationId: string) => `integration:${organizationId}:${K2}`;

interface K2Safe {
  environment: "sandbox" | "production";
  tillNumber: string;
}
interface K2Secret {
  clientId: string;
  clientSecret: string;
  apiKey: string;
}

async function loadK2(organizationId: string) {
  const row = await db.integrationConfiguration.findUnique({ where: { organizationId_provider: { organizationId, provider: K2 } } });
  if (!row) return null;
  const safe = (row.safeConfig ?? null) as K2Safe | null;
  let secret: K2Secret | null = null;
  if (row.encryptedSecret) {
    try {
      secret = JSON.parse(decryptSecret(row.encryptedSecret, k2Aad(organizationId))) as K2Secret;
    } catch {
      throw new PermanentError("Stored Kopo Kopo credentials could not be decrypted (APP_ENCRYPTION_KEY changed?)", "K2_CONFIG_UNREADABLE");
    }
  }
  return { row, safe, secret };
}

/** Kopo Kopo configuration for an organization, or null when not set up. */
export async function kopokopoConfigFor(organizationId: string): Promise<KopoKopoConfig | null> {
  const stored = await loadK2(organizationId);
  if (!stored?.safe?.tillNumber || !stored.secret?.clientId) return null;
  return { environment: stored.safe.environment, tillNumber: stored.safe.tillNumber, ...stored.secret };
}

/** Which gateway collects new online payments. Organizations that never chose one keep using M-Pesa Daraja. */
export async function activeGatewayKey(organizationId: string): Promise<GatewayKey> {
  const row = await db.paymentGatewaySettings.findUnique({ where: { organizationId } });
  return (row?.activeProvider as GatewayKey | undefined) ?? "mpesa_daraja";
}

const secretField = z.string().trim().min(8).max(300);
export const kopokopoConfigInput = z
  .object({
    environment: z.enum(["sandbox", "production"]),
    tillNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^K?\d{5,8}$/, "Use your till number (digits) or online payments account number (K followed by digits)"),
    clientId: secretField.optional(),
    clientSecret: secretField.optional(),
    apiKey: secretField.optional(),
  })
  .superRefine((v, ctx) => {
    const given = [v.clientId, v.clientSecret, v.apiKey].filter(Boolean).length;
    if (given !== 0 && given !== 3) ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Enter the client ID, client secret and API key together." });
  });

export const activeGatewayInput = z.object({ provider: z.enum(GATEWAYS.map((g) => g.key) as [GatewayKey, ...GatewayKey[]]) });

/** Catalogue with each gateway's configuration status (no secrets). */
export async function listGateways(ctx: StaffContext) {
  requirePermission(ctx, "integrations.read");
  const [rows, active, k2] = await Promise.all([
    db.integrationConfiguration.findMany({ where: { organizationId: ctx.organizationId, provider: { in: GATEWAYS.map((g) => g.key) } } }),
    activeGatewayKey(ctx.organizationId),
    loadK2(ctx.organizationId),
  ]);
  return {
    active,
    gateways: GATEWAYS.map((g) => {
      const row = rows.find((r) => r.provider === g.key);
      const configured = g.key === "kopokopo" ? Boolean(k2?.secret && k2.safe?.tillNumber) : Boolean(row?.encryptedSecret);
      return { ...g, features: [...g.features], configured, status: row?.status ?? "NOT_CONFIGURED", lastCheckedAt: row?.lastCheckedAt ?? null, lastError: row?.lastError ?? null, active: g.key === active };
    }),
    kopokopo: k2?.safe ? { environment: k2.safe.environment, tillNumber: k2.safe.tillNumber, credentialsSet: Boolean(k2.secret) } : null,
  };
}

export async function saveKopoKopoSettings(ctx: StaffContext, raw: z.input<typeof kopokopoConfigInput>) {
  requirePermission(ctx, "integrations.write");
  const input = kopokopoConfigInput.parse(raw);
  const stored = await loadK2(ctx.organizationId);
  const secretGiven = Boolean(input.clientId && input.clientSecret && input.apiKey);
  if (!secretGiven && !stored?.secret) throw new AppError("VALIDATION_ERROR", "Enter the Kopo Kopo client ID, client secret and API key.", { fields: [{ path: "clientId", message: "Required" }] });
  const secret: K2Secret = secretGiven ? { clientId: input.clientId!, clientSecret: input.clientSecret!, apiKey: input.apiKey! } : stored!.secret!;
  const safe: K2Safe = { environment: input.environment, tillNumber: input.tillNumber };
  const prev = stored?.safe;
  // Changing where money goes or which credentials are used invalidates any earlier verification.
  const materialChange = !prev || prev.environment !== safe.environment || prev.tillNumber !== safe.tillNumber || secretGiven;
  const encrypted = encryptSecret(JSON.stringify(secret), k2Aad(ctx.organizationId));
  await db.integrationConfiguration.upsert({
    where: { organizationId_provider: { organizationId: ctx.organizationId, provider: K2 } },
    create: { organizationId: ctx.organizationId, provider: K2, status: "NOT_CONFIGURED", safeConfig: safe as unknown as Prisma.InputJsonValue, encryptedSecret: encrypted },
    update: { safeConfig: safe as unknown as Prisma.InputJsonValue, encryptedSecret: encrypted, ...(materialChange ? { status: "NOT_CONFIGURED", lastError: null } : {}) },
  });
  await audit(ctx, { action: "integration.kopokopo.configure", entityType: "integration", entityId: K2, metadata: { environment: safe.environment, tillNumber: safe.tillNumber, credentialsReplaced: secretGiven, verificationReset: materialChange } });
  return listGateways(ctx);
}

/** Fetch an access token to prove the credentials work. Moves no money and does not mark the gateway verified. */
export async function testKopoKopoCredentials(ctx: StaffContext) {
  requirePermission(ctx, "integrations.write");
  const cfg = await kopokopoConfigFor(ctx.organizationId);
  if (!cfg) throw new AppError("INTEGRATION_UNAVAILABLE", "Save the Kopo Kopo settings first.");
  let error: string | null = null;
  try {
    await new KopoKopoGateway(cfg).testCredentials();
  } catch (err) {
    error = err instanceof PermanentError || err instanceof RetryableError ? err.message : "Credential test failed";
  }
  await db.integrationConfiguration.update({
    where: { organizationId_provider: { organizationId: ctx.organizationId, provider: K2 } },
    data: { lastCheckedAt: new Date(), lastError: error, ...(error ? { status: "ERROR" } : {}) },
  });
  await audit(ctx, { action: "integration.kopokopo.test", entityType: "integration", entityId: K2, metadata: { ok: !error } });
  return { ok: !error, error };
}

/** Choose the gateway for new online payments. It must be configured first. */
export async function setActiveGateway(ctx: StaffContext, raw: z.input<typeof activeGatewayInput>) {
  requirePermission(ctx, "integrations.write");
  const { provider } = activeGatewayInput.parse(raw);
  const { gateways, active } = await listGateways(ctx);
  const target = gateways.find((g) => g.key === provider)!;
  if (!target.configured) throw new AppError("INVALID_STATE", `Set up ${target.name} before using it for online payments.`);
  await db.paymentGatewaySettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, activeProvider: provider }, update: { activeProvider: provider } });
  if (active !== provider) await audit(ctx, { action: "integration.gateway.activate", entityType: "integration", entityId: provider, metadata: { from: active, to: provider } });
  return listGateways(ctx);
}

/** A successful real payment through a gateway marks it tested (sandbox) or verified (production). */
export async function recordGatewayVerified(organizationId: string, provider: string, environment: "sandbox" | "production" | "mock") {
  if (environment === "mock" || provider === "mock") return;
  const status = environment === "production" ? "PRODUCTION_VERIFIED" : "SANDBOX_TESTED";
  await db.integrationConfiguration.upsert({
    where: { organizationId_provider: { organizationId, provider } },
    create: { organizationId, provider, status, lastCheckedAt: new Date() },
    update: { status, lastCheckedAt: new Date(), lastError: null },
  });
}
