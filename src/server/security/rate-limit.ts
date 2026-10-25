import "server-only";
import { db } from "@/server/db/client";
import { AppError } from "@/server/errors";

export interface RateLimitRule {
  /** Logical bucket name, e.g. "login:ip". */
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  loginByIp: { name: "login:ip", limit: 20, windowSeconds: 15 * 60 },
  loginByEmail: { name: "login:email", limit: 8, windowSeconds: 15 * 60 },
  webhook: { name: "webhook", limit: 600, windowSeconds: 60 },
  paymentInitiation: { name: "payment:init", limit: 10, windowSeconds: 10 * 60 },
  voucherRedeem: { name: "voucher:redeem", limit: 10, windowSeconds: 10 * 60 },
} satisfies Record<string, RateLimitRule>;

/**
 * Atomic fixed-window counter in PostgreSQL (single upsert statement).
 * Returns remaining requests, or throws RATE_LIMITED.
 */
export async function consumeRateLimit(rule: RateLimitRule, subject: string): Promise<{ remaining: number }> {
  const key = `${rule.name}:${subject}`;
  const rows = await db.$queryRaw<Array<{ count: number; window_start: Date }>>`
    INSERT INTO "RateLimitBucket" ("key", "windowStart", "count")
    VALUES (${key}, now(), 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${rule.windowSeconds})
                     THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "windowStart" = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${rule.windowSeconds})
                     THEN now() ELSE "RateLimitBucket"."windowStart" END
    RETURNING "count" AS count, "windowStart" AS window_start`;
  const row = rows[0];
  const count = Number(row?.count ?? 1);
  if (count > rule.limit) {
    const resetAt = (row?.window_start?.getTime() ?? Date.now()) + rule.windowSeconds * 1000;
    throw new AppError("RATE_LIMITED", undefined, {
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    });
  }
  return { remaining: rule.limit - count };
}

export async function resetRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  await db.rateLimitBucket.deleteMany({ where: { key: `${rule.name}:${subject}` } });
}
