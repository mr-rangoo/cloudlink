import "server-only";
import { z } from "zod";

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

    MIKROTIK_CONNECTION_MODE: z.enum(["mock", "api", "api-ssl"]).default("mock"),
    MIKROTIK_ALLOWED_NETWORKS: z.string().optional().default(""),
    RADIUS_SERVER_ADDRESS: z.string().optional().default(""),
    RADIUS_SHARED_SECRET: z.string().optional().default(""),

    PAYMENT_ADAPTER: z.enum(["mock", "daraja", "disabled"]).default("mock"),
    NETWORK_ADAPTER: z.enum(["mock", "routeros", "disabled"]).default("mock"),
    MESSAGING_ADAPTER: z.enum(["mock", "smtp", "disabled"]).default("mock"),
    STORAGE_ADAPTER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("storage"),
    ENABLE_DEMO_SEED: bool,
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== "production") return;
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.PAYMENT_ADAPTER === "mock") fail("PAYMENT_ADAPTER", "mock payment adapter is not allowed in production");
    if (env.NETWORK_ADAPTER === "mock") fail("NETWORK_ADAPTER", "mock network adapter is not allowed in production");
    if (env.MIKROTIK_CONNECTION_MODE === "mock" && env.NETWORK_ADAPTER === "routeros")
      fail("MIKROTIK_CONNECTION_MODE", "must not be mock when NETWORK_ADAPTER=routeros");
    if (env.MESSAGING_ADAPTER === "mock") fail("MESSAGING_ADAPTER", "mock messaging adapter is not allowed in production");
    if (env.ENABLE_DEMO_SEED) fail("ENABLE_DEMO_SEED", "demo seed must be disabled in production");
    if (!env.APP_URL.startsWith("https://")) fail("APP_URL", "must use https in production");
    if (/replace-with|changeme|example/i.test(env.AUTH_SECRET)) fail("AUTH_SECRET", "placeholder secret detected");
    if (env.PAYMENT_ADAPTER === "daraja" && env.MPESA_CALLBACK_URL && !env.MPESA_CALLBACK_URL.startsWith("https://"))
      fail("MPESA_CALLBACK_URL", "must use https");
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
