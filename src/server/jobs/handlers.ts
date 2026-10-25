import "server-only";
import type { OperationHandlers } from "@/server/jobs/operations";
import { PermanentError } from "@/server/jobs/operations";
import { logger } from "@/server/observability/logger";
import { systemContext } from "@/server/auth/context";
import { expireDueSubscriptions } from "@/server/services/subscriptions";
import { runRecurringBilling } from "@/server/services/invoices";
import { deliverNotification } from "@/server/services/notifications";
import { inviteLink, mintInviteToken } from "@/server/portal/auth";
import { db } from "@/server/db/client";
import { generateExport } from "@/server/services/exports";
import { ensureHotspotOperation, executeNetworkOperation, monitorNetworkOperations, syncNetworkSessions } from "@/server/services/network";
import { runRouterHealthChecks } from "@/server/services/routers";

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

  /** Invoice upcoming subscription periods (idempotent: one invoice per subscription period). */
  "billing.run_recurring": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    const ctx = systemContext(op.organizationId, "worker:billing", op.correlationId ?? op.id);
    const result = await runRecurringBilling(ctx);
    if (result.created) logger.info({ organizationId: op.organizationId, ...result }, "recurring invoices generated");
    return result;
  },

  /** Build a CSV export for the requester (permissions re-checked at generation time). */
  "exports.generate": async (op) => {
    const { exportJobId } = op.payload as { exportJobId?: string };
    if (!exportJobId) throw new PermanentError("exportJobId missing", "BAD_PAYLOAD");
    await generateExport(exportJobId);
  },

  /** Legacy (pre-network-operation) hotspot activation jobs: converted into a durable network operation. */
  "hotspot.activate": async (op) => {
    const { redemptionId } = op.payload as { redemptionId?: string };
    if (!redemptionId) throw new PermanentError("redemptionId missing", "BAD_PAYLOAD");
    await ensureHotspotOperation(redemptionId);
  },

  /** Execute one durable network operation (router API / RADIUS / mock) and record the real outcome. */
  "network.execute": async (op) => {
    const { networkOperationId } = op.payload as { networkOperationId?: string };
    if (!networkOperationId) throw new PermanentError("networkOperationId missing", "BAD_PAYLOAD");
    return executeNetworkOperation(networkOperationId);
  },

  /** Router reachability: one router (manual check) or every active router of the organization (scheduled). */
  "routers.healthcheck": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    const { routerId } = op.payload as { routerId?: string };
    return runRouterHealthChecks(op.organizationId, routerId);
  },

  /** Pull active PPPoE/Hotspot sessions from routers or RADIUS accounting. */
  "network.sync_sessions": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    return syncNetworkSessions(op.organizationId);
  },

  /** Alert on network operations that stopped progressing. */
  "network.monitor": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    return monitorNetworkOperations(op.organizationId);
  },

  /** Deliver one notification through the configured adapter (mock / SMTP / SMS provider). */
  "notifications.send": async (op) => {
    const { notificationId } = op.payload as { notificationId?: string };
    if (!notificationId) throw new PermanentError("notificationId missing", "BAD_PAYLOAD");
    const n = await db.notification.findUnique({ where: { id: notificationId }, select: { templateKey: true, subscriberId: true, organizationId: true } });
    if (n?.templateKey !== "portal.invite") return deliverNotification(notificationId);
    // Portal invites: mint the single-use token now so it is never stored in plaintext.
    await deliverNotification(notificationId, async (row) => {
      const account = n.subscriberId ? await db.customerAccount.findUnique({ where: { subscriberId: n.subscriberId } }) : null;
      if (!account || account.status === "DISABLED") throw new PermanentError("portal access disabled", "PORTAL_DISABLED");
      const org = await db.organization.findUniqueOrThrow({ where: { id: n.organizationId }, select: { slug: true } });
      const link = inviteLink(org.slug, await mintInviteToken(account.id));
      return { send: row.body.replaceAll("{{link}}", link), store: row.body.replaceAll("{{link}}", "[secure link sent - not stored]") };
    });
  },
};
