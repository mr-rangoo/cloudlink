import "server-only";
import type { OperationHandlers } from "@/server/jobs/operations";
import { PermanentError } from "@/server/jobs/operations";
import { logger } from "@/server/observability/logger";
import { systemContext } from "@/server/auth/context";
import { expireDueSubscriptions } from "@/server/services/subscriptions";

/**
 * Registry of background operation handlers shared by the worker and tests.
 * Handlers must be idempotent: they can run again after a crash or retry.
 */
export const operationHandlers: OperationHandlers = {
  /** Diagnostic no-op used by health tooling and tests to prove the pipeline end to end. */
  "system.ping": async (op) => {
    logger.info({ operationId: op.id }, "system.ping processed");
    return { ok: true };
  },

  /** Expire subscriptions whose paid period plus grace days has elapsed (state machine guarded, idempotent). */
  "subscriptions.expire_due": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    const ctx = systemContext(op.organizationId, "worker:subscriptions", op.correlationId ?? op.id);
    const expired = await expireDueSubscriptions(op.organizationId, ctx);
    if (expired) logger.info({ organizationId: op.organizationId, expired }, "subscriptions expired");
    return { expired };
  },
};
