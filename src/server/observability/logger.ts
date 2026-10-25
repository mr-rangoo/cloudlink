import "server-only";
import pino from "pino";

/**
 * Structured JSON logger with mandatory redaction of secrets and sensitive personal data.
 * Never log raw request bodies from payment providers or router credentials.
 */
export const REDACT_PATHS = [
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "secret",
  "*.secret",
  "*.consumerSecret",
  "*.passkey",
  "*.Password",
  "*.sharedSecret",
  "*.encryptedSecret",
  "authorization",
  "*.authorization",
  "headers.cookie",
  "*.headers.cookie",
  "req.headers.cookie",
  "req.headers.authorization",
  "cookie",
  "*.cookie",
  "*.pin",
  "*.PhoneNumber",
  "*.phone",
  "*.msisdn",
];

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

export const logger = pino({
  level,
  base: { service: process.env.CLOUDLINK_SERVICE ?? "cloudlink-web" },
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});

export type Logger = typeof logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/** Masks a Kenyan MSISDN or email for display in logs / UIs where full value is not needed. */
export function maskContact(value: string | null | undefined): string {
  if (!value) return "";
  if (value.includes("@")) {
    const [user, domain] = value.split("@");
    return `${(user ?? "").slice(0, 2)}***@${domain ?? ""}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6) return "***";
  return `${digits.slice(0, 4)}***${digits.slice(-3)}`;
}
