import "server-only";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { messagingStatus, type IntegrationStatus } from "@/server/integrations/messaging";
import { pingRedis } from "@/server/jobs/redis";
import { workerStatus } from "@/server/observability/health";
import { radiusConfigured, radiusHealth } from "@/server/integrations/radius";

export interface IntegrationRow {
  key: string;
  name: string;
  category: "payments" | "network" | "messaging" | "infrastructure";
  status: IntegrationStatus | "ok" | "unavailable";
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

export async function integrationStatus(ctx: StaffContext): Promise<IntegrationRow[]> {
  requirePermission(ctx, "integrations.read");
  const configs = await db.integrationConfiguration.findMany({ where: { organizationId: ctx.organizationId }, select: { provider: true, status: true, lastCheckedAt: true, lastError: true } });
  const recorded = (provider: string) => configs.find((c) => c.provider === provider);
  const mapStatus = (s: string | undefined): IntegrationStatus | undefined =>
    s === "SANDBOX_TESTED" ? "sandbox_tested" : s === "PRODUCTION_VERIFIED" ? "production_verified" : s === "ERROR" ? "error" : undefined;

  const paymentMode = process.env.PAYMENT_ADAPTER ?? "mock";
  const darajaVars = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL"].filter((k) => !process.env[k]);
  const networkMode = process.env.NETWORK_ADAPTER ?? "mock";
  const messaging = messagingStatus();
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
      status: mapStatus(recorded("mpesa_daraja")?.status) ?? (paymentMode === "mock" ? "mock" : "not_configured"),
      detail: paymentMode === "mock" ? "Simulated payments only; no money moves." : darajaVars.length ? `Missing settings: ${darajaVars.join(", ")}` : `${process.env.MPESA_ENVIRONMENT ?? "sandbox"} credentials present; not yet verified.`,
      phase: 8,
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
    { key: "sms", name: `SMS (${messaging.sms.provider})`, category: "messaging", mode: process.env.MESSAGING_ADAPTER ?? "mock", status: mapStatus(recorded("sms")?.status) ?? messaging.sms.status, detail: messaging.sms.available ? (messaging.sms.status === "mock" ? "Messages are simulated, not delivered." : "Configured; not yet verified with a real send.") : "Not configured: messages are skipped." },
    { key: "email", name: `Email (${messaging.email.provider})`, category: "messaging", mode: process.env.MESSAGING_ADAPTER ?? "mock", status: mapStatus(recorded("smtp")?.status) ?? messaging.email.status, detail: messaging.email.available ? (messaging.email.status === "mock" ? "Messages are simulated, not delivered." : "Configured; not yet verified with a real send.") : "Not configured: messages are skipped." },
    { key: "storage", name: `File storage (${process.env.STORAGE_ADAPTER ?? "local"})`, category: "infrastructure", mode: process.env.STORAGE_ADAPTER ?? "local", status: (process.env.STORAGE_ADAPTER ?? "local") === "local" ? "ok" : "not_configured", detail: (process.env.STORAGE_ADAPTER ?? "local") === "local" ? "Local disk; suitable for a single server. Use S3-compatible storage for multi-node deployments." : "S3 adapter not implemented yet." },
    { key: "redis", name: "Redis / BullMQ", category: "infrastructure", mode: process.env.REDIS_URL ? "configured" : "none", status: redis === "ok" ? "ok" : redis === "not_configured" ? "not_configured" : "unavailable", detail: redis === "ok" ? "Jobs dispatch immediately." : "Worker falls back to database polling (slower, still durable)." },
    { key: "worker", name: "Background worker", category: "infrastructure", mode: "process", status: workers.some((w) => w.healthy) ? "ok" : "unavailable", detail: workers.some((w) => w.healthy) ? `${workers.filter((w) => w.healthy).length} worker(s) online` : "No worker heartbeat in the last minute: billing, notifications and exports are not being processed." },
  ];
}
