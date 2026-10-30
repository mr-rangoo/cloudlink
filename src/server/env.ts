import "server-only";
import { z } from "zod";
import { isPrivateNetwork, parseCidrList } from "@/server/domain/network-address";

/**
 * Environment validation.
 *
 * APP_ENV is the deployment environment (development | test | staging | production) and is
 * deliberately separate from NODE_ENV, because `next build` always runs with NODE_ENV=production.
 * Production guards (no mock adapters, no demo seed, strong secrets) key off APP_ENV.
 */

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const base64Key32 = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be 32 bytes encoded as base64 (e.g. `openssl rand -base64 32`)" },
);

export const envSchema = z
  .object({
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    APP_URL: z.url(),
    APP_TIMEZONE: z.string().default("Africa/Nairobi"),
    DEFAULT_CURRENCY: z.string().length(3).default("KES"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    DATABASE_URL: z.string().min(1).startsWith("postgres"),
    REDIS_URL: z.string().optional().default(""),

    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    APP_ENCRYPTION_KEY: base64Key32,
    SESSION_TTL_HOURS: z.coerce.number().int().positive().max(24 * 30).default(12),

    MPESA_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    MPESA_CONSUMER_KEY: z.string().optional().default(""),
    MPESA_CONSUMER_SECRET: z.string().optional().default(""),
    MPESA_SHORTCODE: z.string().optional().default(""),
    MPESA_PASSKEY: z.string().optional().default(""),
    MPESA_CALLBACK_URL: z.string().optional().default(""),
    /** Organization (slug) that uses the MPESA_* variables when it has no credentials saved in Integrations. */
    MPESA_ENV_ORGANIZATION: z.string().optional().default(""),
    MPESA_SHORTCODE_TYPE: z.enum(["PAYBILL", "TILL"]).default("PAYBILL"),
    MPESA_TILL_NUMBER: z.string().optional().default(""),
    /** Optional comma-separated IPs/CIDRs allowed to call the M-Pesa webhooks (first X-Forwarded-For hop). */
    MPESA_CALLBACK_ALLOWED_IPS: z.string().optional().default(""),
    /** Confirm every successful callback with an STK Push Query before recording money (default on). */
    MPESA_VERIFY_CALLBACKS: z.enum(["true", "false"]).default("true"),
    /** Non-production only: point the Daraja adapter at a fake server (tests). */
    MPESA_BASE_URL: z.string().optional().default(""),

    MIKROTIK_CONNECTION_MODE: z.enum(["mock", "api", "api-ssl"]).default("mock"),
    MIKROTIK_ALLOWED_NETWORKS: z.string().optional().default(""),
    RADIUS_SERVER_ADDRESS: z.string().optional().default(""),
    RADIUS_SHARED_SECRET: z.string().optional().default(""),
    /** FreeRADIUS SQL database (radcheck/radreply/radusergroup/radacct). Optional; RADIUS provisioning is unavailable without it. */
    RADIUS_DATABASE_URL: z.string().optional().default(""),
    RADIUS_DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, "must be a lowercase SQL identifier").default("public"),
    ROUTEROS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
    /** Addresses the Cloudlink worker connects to routers from (e.g. its VPN address); written into router setup scripts. */
    ROUTER_MANAGEMENT_SOURCES: z.string().optional().default(""),

    /** mock | daraja (or live): real gateways chosen per organization (M-Pesa Daraja, Kopo Kopo) | disabled. */
    PAYMENT_ADAPTER: z.enum(["mock", "daraja", "live", "disabled"]).default("mock"),
    /** Non-production only: point the Kopo Kopo adapter at a fake server (tests). */
    KOPOKOPO_BASE_URL: z.string().optional().default(""),
    NETWORK_ADAPTER: z.enum(["mock", "routeros", "disabled"]).default("mock"),
    MESSAGING_ADAPTER: z.enum(["mock", "live", "smtp", "disabled"]).default("mock"),
    /** Customer-portal AI assistant: anthropic (Claude API), mock (simulated replies, non-production only), disabled. */
    ASSISTANT_ADAPTER: z.enum(["anthropic", "mock", "disabled"]).default("disabled"),
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    ASSISTANT_MODEL: z.string().regex(/^claude-[a-z0-9-]+$/, "must be a Claude model id").default("claude-opus-5-5"),
    ASSISTANT_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
    /** Non-production only: point the Claude adapter at a fake server (tests). */
    ASSISTANT_BASE_URL: z.string().optional().default(""),
    STORAGE_ADAPTER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("storage"),
    ENABLE_DEMO_SEED: bool,
    /** Self-service sign-up for new ISP workspaces (email confirmation required): open | closed. */
    SIGNUP_MODE: z.enum(["open", "closed"]).default("open"),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.MIKROTIK_ALLOWED_NETWORKS.trim()) {
      try {
        for (const c of parseCidrList(env.MIKROTIK_ALLOWED_NETWORKS)) {
          if (!isPrivateNetwork(c, env.APP_ENV !== "production")) fail("MIKROTIK_ALLOWED_NETWORKS", `${c.address}/${c.prefix} is not a private network`);
        }
      } catch {
        fail("MIKROTIK_ALLOWED_NETWORKS", "must be a comma-separated list of CIDR networks");
      }
    }
    if (env.RADIUS_DATABASE_URL && !env.RADIUS_DATABASE_URL.startsWith("postgres")) fail("RADIUS_DATABASE_URL", "must be a PostgreSQL connection string");
    if (env.ROUTER_MANAGEMENT_SOURCES.trim()) {
      try {
        for (const c of parseCidrList(env.ROUTER_MANAGEMENT_SOURCES)) {
          if (!isPrivateNetwork(c, env.APP_ENV !== "production")) fail("ROUTER_MANAGEMENT_SOURCES", `${c.address}/${c.prefix} is not a private (VPN/LAN) address`);
        }
      } catch {
        fail("ROUTER_MANAGEMENT_SOURCES", "must be a comma-separated list of IP addresses or CIDR networks");
      }
    }
    if (env.APP_ENV !== "production") return;
    if (env.NETWORK_ADAPTER === "routeros" && !env.MIKROTIK_ALLOWED_NETWORKS.trim())
      fail("MIKROTIK_ALLOWED_NETWORKS", "is required in production when NETWORK_ADAPTER=routeros");
    if (env.PAYMENT_ADAPTER === "mock") fail("PAYMENT_ADAPTER", "mock payment adapter is not allowed in production");
    if (env.NETWORK_ADAPTER === "mock") fail("NETWORK_ADAPTER", "mock network adapter is not allowed in production");
    if (env.MIKROTIK_CONNECTION_MODE === "mock" && env.NETWORK_ADAPTER === "routeros")
      fail("MIKROTIK_CONNECTION_MODE", "must not be mock when NETWORK_ADAPTER=routeros");
    if (env.MESSAGING_ADAPTER === "mock") fail("MESSAGING_ADAPTER", "mock messaging adapter is not allowed in production");
    if (env.ASSISTANT_ADAPTER === "mock") fail("ASSISTANT_ADAPTER", "mock assistant is not allowed in production");
    if (env.ASSISTANT_ADAPTER === "anthropic" && !env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY", "is required when ASSISTANT_ADAPTER=anthropic");
    if (env.ASSISTANT_BASE_URL) fail("ASSISTANT_BASE_URL", "is a test-only override and must be empty in production");
    if (env.ENABLE_DEMO_SEED) fail("ENABLE_DEMO_SEED", "demo seed must be disabled in production");
    if (!env.APP_URL.startsWith("https://")) fail("APP_URL", "must use https in production");
    if (/replace-with|changeme|example/i.test(env.AUTH_SECRET)) fail("AUTH_SECRET", "placeholder secret detected");
    if (env.KOPOKOPO_BASE_URL) fail("KOPOKOPO_BASE_URL", "is a test-only override and must be empty in production");
    if ((env.PAYMENT_ADAPTER === "daraja" || env.PAYMENT_ADAPTER === "live") && env.MPESA_CALLBACK_URL && !env.MPESA_CALLBACK_URL.startsWith("https://"))
      fail("MPESA_CALLBACK_URL", "must use https");
    if (env.MPESA_BASE_URL) fail("MPESA_BASE_URL", "is a test-only override and must be empty in production");
    if (env.MPESA_VERIFY_CALLBACKS === "false") fail("MPESA_VERIFY_CALLBACKS", "callback verification cannot be disabled in production");
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n - ${issues.join("\n - ")}`);
    this.name = "EnvValidationError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Report variable names and rule violations only; never echo values.
    throw new EnvValidationError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}

/** Lazily validated environment. Throws EnvValidationError with variable names only (never values). */
export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

export function isProduction(): boolean {
  return env().APP_ENV === "production";
}

/** For tests only. */
export function resetEnvCache(): void {
  cached = undefined;
}
