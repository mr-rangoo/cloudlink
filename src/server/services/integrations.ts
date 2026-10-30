import "server-only";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import type { IntegrationStatus } from "@/server/integrations/messaging";
import { getMessagingSettings } from "@/server/services/messaging-config";
import { pingRedis } from "@/server/jobs/redis";
import { workerStatus } from "@/server/observability/health";
import { radiusConfigured, radiusHealth } from "@/server/integrations/radius";
import { activeGatewayKey, kopokopoConfigFor } from "@/server/services/payment-gateways";
import { darajaConfigFor, paymentAdapterMode } from "@/server/services/mpesa-config";

export interface IntegrationRow {
  key: string;
  name: string;
  category: "payments" | "network" | "messaging" | "infrastructure";
  status: IntegrationStatus | "ok" | "unavailable" | "configured";
  mode: string;
  detail: string;
  phase?: number;
}

/**
 * Honest integration status. Nothing is reported as sandbox-tested or production-verified unless a recorded
 * verification exists in IntegrationConfiguration (set only by an explicit, successful test — phases 7–8).
 * Secrets are never returned; only whether required settings are present.
 */
/** RouterOS row: "ok" only when a real (non-mock) health check has seen at least one router online. */
function routerStatus(mode: string, routers: { total: number; online: number }): IntegrationRow["status"] {
  if (mode === "mock") return "mock";
  if (mode !== "routeros" || routers.total === 0) return "not_configured";
  return routers.online > 0 ? "ok" : "unavailable";
}

const PROVIDER_NAME: Record<string, string> = { africastalking: "Africa's Talking", twilio: "Twilio", smtp: "SMTP", "mock-sms": "mock", "mock-email": "mock", sms: "none", email: "none" };

/** SMS / email row: verified only after a staff member confirmed a test message arrived (see messaging-config). */
function messagingRow(
  key: "sms" | "email",
  label: string,
  mode: string,
  inUse: { provider: string; source: string; available: boolean },
  recorded: IntegrationStatus | undefined,
  lastTest: { at: string; accepted: boolean; confirmedAt: string | null } | null,
): IntegrationRow {
  const name = `${label} (${PROVIDER_NAME[inUse.provider] ?? inUse.provider})`;
  if (mode === "mock") return { key, name, category: "messaging", mode, status: "mock", detail: "Messages are simulated, not delivered." };
  if (!inUse.available) return { key, name, category: "messaging", mode, status: "not_configured", detail: "Not configured: messages are skipped. Set up a provider in the Messaging section below." };
  const where = inUse.source === "environment" ? "server environment" : "saved in Cloudlink";
  const test = lastTest ? (lastTest.accepted ? `Test accepted ${lastTest.at.slice(0, 10)}${lastTest.confirmedAt ? ", arrival confirmed" : "; confirm it arrived to verify"}.` : "Last test was not accepted.") : "Not tested yet.";
  return { key, name, category: "messaging", mode, status: recorded ?? "configured", detail: `Configured (${where}). ${test}` };
}

export async function integrationStatus(ctx: StaffContext): Promise<IntegrationRow[]> {
  requirePermission(ctx, "integrations.read");
  const configs = await db.integrationConfiguration.findMany({ where: { organizationId: ctx.organizationId }, select: { provider: true, status: true, lastCheckedAt: true, lastError: true } });
  const recorded = (provider: string) => configs.find((c) => c.provider === provider);
  const mapStatus = (s: string | undefined): IntegrationStatus | undefined =>
    s === "SANDBOX_TESTED" ? "sandbox_tested" : s === "PRODUCTION_VERIFIED" ? "production_verified" : s === "ERROR" ? "error" : undefined;

  const paymentMode = paymentAdapterMode();
  const mpesa = paymentMode === "daraja" ? await darajaConfigFor(ctx.organizationId).catch(() => null) : null;
  const k2 = paymentMode === "daraja" ? await kopokopoConfigFor(ctx.organizationId).catch(() => null) : null;
  const activeGateway = await activeGatewayKey(ctx.organizationId);
  const networkMode = process.env.NETWORK_ADAPTER ?? "mock";
  const messaging = await getMessagingSettings(ctx);
  const [redis, workers, routerGroups, radius] = await Promise.all([
    pingRedis(),
    workerStatus(),
    db.router.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId, archivedAt: null }, _count: { _all: true } }),
    radiusHealth(),
  ]);
  const routers = {
    total: routerGroups.reduce((n, g) => n + g._count._all, 0),
    online: routerGroups.find((g) => g.status === "ONLINE")?._count._all ?? 0,
  };

  return [
    {
      key: "mpesa_daraja",
      name: "M-Pesa (Daraja)",
      category: "payments",
      mode: paymentMode,
      status: paymentMode === "mock" ? "mock" : paymentMode === "disabled" ? "not_configured" : (mapStatus(recorded("mpesa_daraja")?.status) ?? (mpesa ? "configured" : "not_configured")),
      detail:
        paymentMode === "mock"
          ? "Simulated: no prompt is sent and no money moves. Staff can simulate the customer's response outside production."
          : paymentMode === "disabled"
            ? "Online payment is disabled (PAYMENT_ADAPTER=disabled)."
            : mpesa
              ? `${mpesa.config.environment === "production" ? "Production" : "Sandbox"} credentials for shortcode ${mpesa.config.shortcode} (${mpesa.source === "environment" ? "server environment" : "saved in Cloudlink"}). Marked tested only after a confirmed payment.`
              : "Not configured: save the Daraja credentials below.",
    },
    {
      key: "kopokopo",
      name: "Kopo Kopo (K2 Connect)",
      category: "payments",
      mode: paymentMode,
      status: paymentMode === "mock" ? "mock" : paymentMode === "disabled" ? "not_configured" : (mapStatus(recorded("kopokopo")?.status) ?? (k2 ? "configured" : "not_configured")),
      detail:
        paymentMode === "mock"
          ? "Simulated in test mode."
          : paymentMode === "disabled"
            ? "Online payment is disabled (PAYMENT_ADAPTER=disabled)."
            : k2
              ? `${k2.environment === "production" ? "Production" : "Sandbox"} credentials for till ${k2.tillNumber}${activeGateway === "kopokopo" ? ", collecting online payments" : ""}. Marked tested only after a confirmed payment.`
              : "Not set up (optional): see Payment gateways below.",
    },
    { key: "manual_payments", name: "Cash / bank / cheque", category: "payments", mode: "built-in", status: "ok", detail: "Recorded and confirmed by authorised staff." },
    {
      key: "mikrotik_routeros",
      name: "MikroTik RouterOS",
      category: "network",
      mode: networkMode,
      status: mapStatus(recorded("mikrotik_routeros")?.status) ?? routerStatus(networkMode, routers),
      detail:
        networkMode === "mock"
          ? `Simulated: no router is contacted or changed. ${routers.total} router(s) registered.`
          : networkMode === "routeros"
            ? routers.total
              ? `${routers.online} of ${routers.total} router(s) online at the last health check (RouterOS API over private network/VPN).${process.env.MIKROTIK_ALLOWED_NETWORKS ? "" : " Set MIKROTIK_ALLOWED_NETWORKS to restrict router addresses."}`
              : "No routers registered yet."
            : "Network automation is disabled; operations fail with a clear reason.",
    },
    {
      key: "radius",
      name: "RADIUS (FreeRADIUS SQL)",
      category: "network",
      mode: radiusConfigured() ? "sql" : "none",
      status: mapStatus(recorded("radius")?.status) ?? (radius.ok ? "ok" : radiusConfigured() ? "error" : "not_configured"),
      detail: radius.ok
        ? `Provisioning tables reachable (schema ${process.env.RADIUS_DB_SCHEMA || "public"}). Not yet verified with a live RADIUS server.`
        : radiusConfigured()
          ? radius.detail
          : "Not configured: routers set to RADIUS authentication cannot be provisioned. See docs/NETWORK.md.",
    },
    messagingRow("sms", "SMS", messaging.mode, messaging.sms.inUse, mapStatus(recorded("sms")?.status), messaging.sms.lastTest),
    messagingRow("email", "Email", messaging.mode, messaging.email.inUse, mapStatus(recorded("email")?.status), messaging.email.lastTest),
    { key: "storage", name: `File storage (${process.env.STORAGE_ADAPTER ?? "local"})`, category: "infrastructure", mode: process.env.STORAGE_ADAPTER ?? "local", status: (process.env.STORAGE_ADAPTER ?? "local") === "local" ? "ok" : "not_configured", detail: (process.env.STORAGE_ADAPTER ?? "local") === "local" ? "Local disk; suitable for a single server. Use S3-compatible storage for multi-node deployments." : "S3 adapter not implemented yet." },
    { key: "redis", name: "Redis / BullMQ", category: "infrastructure", mode: process.env.REDIS_URL ? "configured" : "none", status: redis === "ok" ? "ok" : redis === "not_configured" ? "not_configured" : "unavailable", detail: redis === "ok" ? "Jobs dispatch immediately." : "Worker falls back to database polling (slower, still durable)." },
    { key: "worker", name: "Background worker", category: "infrastructure", mode: "process", status: workers.some((w) => w.healthy) ? "ok" : "unavailable", detail: workers.some((w) => w.healthy) ? `${workers.filter((w) => w.healthy).length} worker(s) online` : "No worker heartbeat in the last minute: billing, notifications and exports are not being processed." },
  ];
}
