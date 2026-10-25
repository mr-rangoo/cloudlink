import "server-only";
import type { OperationHandlers } from "@/server/jobs/operations";
import { logger } from "@/server/observability/logger";

/**
 * Registry of background operation handlers shared by the worker and tests.
 * Domain phases register their handlers here (billing, notifications, network, webhooks).
 */
export const operationHandlers: OperationHandlers = {
  /** Diagnostic no-op used by health tooling and tests to prove the pipeline end to end. */
  "system.ping": async (op) => {
    logger.info({ operationId: op.id }, "system.ping processed");
    return { ok: true };
  },
};
