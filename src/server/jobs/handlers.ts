import "server-only";
import { syncTr069Devices } from "@/server/services/tr069";
import type { OperationHandlers } from "@/server/jobs/operations";
import { PermanentError } from "@/server/jobs/operations";
import { logger } from "@/server/observability/logger";
import { systemContext } from "@/server/auth/context";
import { expireDueSubscriptions, remindExpiringSubscriptions } from "@/server/services/subscriptions";
import { runRecurringBilling } from "@/server/services/invoices";
import { deliverNotification } from "@/server/services/notifications";
import { inviteLink, mintInviteToken } from "@/server/portal/auth";
import { db } from "@/server/db/client";
import { generateExport } from "@/server/services/exports";
import { voucherCodeForDelivery } from "@/server/services/vouchers";
import { campaignIdOf, dispatchCampaign } from "@/server/services/campaigns";
import { sendDailyDigest } from "@/server/services/operator-alerts";
import { enforcePlanSchedules, ensureHotspotOperation, executeNetworkOperation, monitorNetworkOperations, syncNetworkSessions } from "@/server/services/network";
import { runRouterHealthChecks } from "@/server/services/routers";
import { pruneRouterTelemetry } from "@/server/services/router-insights";
import { processStkEvent, runStatusQuery } from "@/server/services/mobile-money";
import { pruneRoutineOperations } from "@/server/jobs/scheduler";
import { pruneAssistantConversations } from "@/server/assistant/service";

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

  /** Remind customers whose plan of a week or longer ends soon (once per period; window from billing settings). */
  "subscriptions.remind_expiring": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    return remindExpiringSubscriptions(op.organizationId);
  },

  /** Write a campaign's messages in batches (resumable; recipients already written are skipped). */
  "campaigns.dispatch": async (op) => dispatchCampaign(campaignIdOf(op.payload)),

  /** Yesterday's summary to the operators, at the organization's chosen hour (once per day). */
  "operators.daily_digest": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    return sendDailyDigest(op.organizationId);
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

  /** Read the organization's enrolled TR-069 devices from the ACS (check-ins, model, firmware, signal). */
  "tr069.sync": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    return syncTr069Devices(op.organizationId);
  },

  /** Pull active PPPoE/Hotspot sessions from routers or RADIUS accounting. */
  "network.sync_sessions": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    return syncNetworkSessions(op.organizationId);
  },

  /** Ask M-Pesa for the final state of an STK request when no callback arrived (bounded retries). */
  "payments.mpesa.query": async (op) => {
    const { attemptId } = op.payload as { attemptId?: string };
    if (!attemptId) throw new PermanentError("attemptId missing", "BAD_PAYLOAD");
    return runStatusQuery(attemptId, { final: op.attempts >= op.maxAttempts });
  },

  /** Verify a stored success callback with the provider before recording money (retried while M-Pesa is busy). */
  "payments.mpesa.verify": async (op) => {
    const { eventId } = op.payload as { eventId?: string };
    if (!eventId) throw new PermanentError("eventId missing", "BAD_PAYLOAD");
    await processStkEvent(eventId, { final: op.attempts >= op.maxAttempts });
  },

  /** Daily: remove old succeeded routine operations (session syncs, health checks), router telemetry past retention and expired assistant chats. */
  "maintenance.prune": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    const operations = await pruneRoutineOperations(op.organizationId);
    const chats = await pruneAssistantConversations(op.organizationId);
    const telemetry = await pruneRouterTelemetry(op.organizationId);
    return { operations: operations.deleted, assistantChats: chats.deleted, routerSamples: telemetry.samples, routerSnapshots: telemetry.snapshots };
  },

  /** Switch scheduled plans (e.g. night plans) on or off at their time-window boundaries. */
  "plans.enforce_schedules": async (op) => {
    if (!op.organizationId) throw new PermanentError("organizationId missing", "BAD_PAYLOAD");
    return enforcePlanSchedules(op.organizationId);
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
    const n = await db.notification.findUnique({ where: { id: notificationId }, select: { templateKey: true, subscriberId: true, organizationId: true, metadata: true } });
    if (n?.templateKey === "voucher.delivery") {
      // The code is read and decrypted only now, and the stored copy of the message never contains it.
      const voucherId = (n.metadata as { voucherId?: string } | null)?.voucherId;
      if (!voucherId) throw new PermanentError("voucher missing", "BAD_PAYLOAD");
      return deliverNotification(notificationId, async (row) => {
        const code = await voucherCodeForDelivery(n.organizationId, voucherId);
        return { send: row.body.replaceAll("{{code}}", code), store: row.body.replaceAll("{{code}}", "[voucher code sent - not stored]") };
      });
    }
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
