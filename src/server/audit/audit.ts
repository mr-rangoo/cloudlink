import "server-only";
import { db, type Tx } from "@/server/db/client";
import type { ActorContext } from "@/server/auth/context";
import type { Prisma } from "@/generated/prisma/client";

const SENSITIVE_KEY = /pass(word|key)?|secret|token|authorization|cookie|pin$|credential|apikey|api_key/i;

/** Recursively strip sensitive keys from audit metadata. */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactMetadata(v, depth + 1));
  if (value && typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function" && !(value instanceof Date)) {
      return (value as { toJSON: () => unknown }).toJSON();
    }
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redactMetadata(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditInput {
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export async function audit(ctx: ActorContext, input: AuditInput, tx?: Tx): Promise<void> {
  const client = tx ?? db;
  await client.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      actorUserId: ctx.kind === "staff" ? ctx.userId : null,
      actorType: ctx.kind === "staff" ? "user" : ctx.kind === "customer" ? `customer:${ctx.customerAccountId}` : ctx.actor,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata ? (redactMetadata(input.metadata) as Prisma.InputJsonValue) : undefined,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent?.slice(0, 256) ?? null,
      correlationId: ctx.correlationId,
    },
  });
}

/** Audit events that happen before a tenant context exists (e.g. failed logins). */
export async function auditAnonymous(
  input: AuditInput & { organizationId?: string | null; actorUserId?: string | null; ipAddress?: string | null; userAgent?: string | null; correlationId?: string },
): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? "user" : "anonymous",
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata ? (redactMetadata(input.metadata) as Prisma.InputJsonValue) : undefined,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 256) ?? null,
      correlationId: input.correlationId ?? null,
    },
  });
}
