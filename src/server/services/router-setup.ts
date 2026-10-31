import "server-only";
import { randomInt } from "node:crypto";
import net from "node:net";
import { db } from "@/server/db/client";
import { requirePermission, systemContext, tenantWhere, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { randomToken, sha256 } from "@/server/security/crypto";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { parseCidrList } from "@/server/domain/network-address";
import { buildSetupScript, setupCommand, SETUP_USERNAME } from "@/server/domain/routeros-setup";
import { agentInstallLines } from "@/server/domain/router-agent";
import { dispatchOperation, enqueueOperation } from "@/server/jobs/operations";
import { networkAdapterName } from "@/server/integrations/network";
import { storeRouterCredentials } from "@/server/services/routers";
import { logger } from "@/server/observability/logger";

/**
 * One-time router setup command.
 *
 * Staff generate a command on the router page and paste it into the router's terminal:
 *   /tool fetch mode=https url="https://<cloudlink>/api/v1/routers/setup/<token>" dst-path=cloudlink-setup.rsc; :delay 2s; /import …
 * The token is random (256 bits), stored only as a hash, valid for 30 minutes and usable once. Fetching it rotates the
 * router's API credentials: a new password is generated, stored encrypted in Cloudlink and written into the script.
 * The script restricts the API to Cloudlink's management addresses (ROUTER_MANAGEMENT_SOURCES), so it never exposes
 * the API to the internet. Cloudlink still reaches the router only over its private/VPN address.
 * The script also names the router and installs the Cloudlink agent with a fresh per-router key (stored hashed): the
 * router then checks in every minute over HTTPS and picks up changes (domain/router-agent.ts).
 */
export const SETUP_TTL_MS = 30 * 60_000;
const PRIVATE_DEFAULTS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];

/** Where Cloudlink's worker connects from, as the router sees it. Defaults to private ranges only. */
export function managementSources(): { sources: string[]; configured: boolean } {
  const raw = process.env.ROUTER_MANAGEMENT_SOURCES ?? "";
  const list = raw.trim() ? parseCidrList(raw).map((c) => `${c.address}/${c.prefix}`) : [];
  return list.length ? { sources: list, configured: true } : { sources: PRIVATE_DEFAULTS, configured: false };
}

function generatePassword(length = 24): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function appBaseUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}
const baseUrl = appBaseUrl;

/** The agent's check-in address for a router key. */
export function agentUrl(key: string): string {
  return `${baseUrl()}/api/v1/routers/agent/${key}`;
}

/** Routers verify Cloudlink's certificate unless ROUTER_AGENT_VERIFY_TLS=false (only for a CA the router cannot trust). */
export function agentVerifyTls(): boolean {
  return process.env.ROUTER_AGENT_VERIFY_TLS !== "false";
}

export async function createSetupCommand(ctx: StaffContext, routerId: string) {
  requirePermission(ctx, "routers.write");
  const router = await db.router.findFirst({ where: { id: routerId, ...tenantWhere(ctx) } });
  if (!router) throw notFound("router");
  if (router.archivedAt) throw new AppError("INVALID_STATE", "Archived routers cannot be set up.");
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
  await db.router.update({ where: { id: router.id }, data: { setupTokenHash: sha256(token), setupExpiresAt: expiresAt } });
  const url = `${baseUrl()}/api/v1/routers/setup/${token}`;
  const mgmt = managementSources();
  const warnings: string[] = [];
  if (!url.startsWith("https://")) warnings.push("This link is not HTTPS. Use it only in development; production requires HTTPS.");
  if (!mgmt.configured) warnings.push("ROUTER_MANAGEMENT_SOURCES is not set, so API access is limited to private networks in general. Set it to Cloudlink's VPN address for a tighter restriction.");
  if (router.pppoeAuth === "RADIUS" && !(process.env.RADIUS_SERVER_ADDRESS && process.env.RADIUS_SHARED_SECRET)) warnings.push("RADIUS_SERVER_ADDRESS and RADIUS_SHARED_SECRET are not set, so the script will not configure RADIUS.");
  if (router.host && networkAdapterName() !== "routeros") warnings.push("The network adapter is not RouterOS, so Cloudlink will not contact this router over its API after setup.");
  if (url.startsWith("https://") && agentVerifyTls()) warnings.push("The router checks Cloudlink's certificate on every check-in. If the router log shows certificate errors, import the issuing CA certificate on the router.");
  await audit(ctx, { action: "router.setup_command.create", entityType: "router", entityId: router.id, metadata: { expiresAt: expiresAt.toISOString() } });
  return { command: setupCommand(url), expiresAt, warnings, managementSources: mgmt.sources };
}

const INVALID = "# This Cloudlink setup link is invalid, expired or already used. Generate a new command on the router page.\n";

/** Public: the router downloads its setup script. Single use; rotates the API credentials. */
export async function serveSetupScript(token: string, meta: { ipAddress: string | null; correlationId: string }): Promise<{ status: number; body: string }> {
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) return { status: 404, body: INVALID };
  await consumeRateLimit({ name: "router:setup", limit: 30, windowSeconds: 600 }, meta.ipAddress ?? "unknown");
  const hash = sha256(token);
  const router = await db.router.findUnique({ where: { setupTokenHash: hash } });
  const now = new Date();
  if (!router || !router.setupExpiresAt || router.setupExpiresAt <= now || router.archivedAt) return { status: 404, body: INVALID };
  // Claim atomically: a second download of the same link gets nothing.
  const agentKey = randomToken(32);
  const claimed = await db.router.updateMany({
    where: { id: router.id, setupTokenHash: hash },
    data: { setupTokenHash: null, setupExpiresAt: null, onboardedAt: now, onboardedFromIp: meta.ipAddress, agentKeyHash: sha256(agentKey) },
  });
  if (!claimed.count) return { status: 404, body: INVALID };

  const password = generatePassword();
  await storeRouterCredentials(router.id, SETUP_USERNAME, password, null);
  const radiusAddress = process.env.RADIUS_SERVER_ADDRESS ?? "";
  const radius = router.pppoeAuth === "RADIUS" && net.isIP(radiusAddress) && process.env.RADIUS_SHARED_SECRET ? { address: radiusAddress, secret: process.env.RADIUS_SHARED_SECRET } : null;
  let hotspotHost: string | null = null;
  if (router.hotspotEnabled) {
    try {
      hotspotHost = new URL(baseUrl()).hostname;
    } catch {
      hotspotHost = null;
    }
  }
  const script = buildSetupScript({
    routerName: router.name,
    apiPort: router.apiPort,
    useTls: router.useTls,
    password,
    managementSources: managementSources().sources,
    radius,
    hotspotHost,
    hotspotLoginUrl: hotspotHost ? `${baseUrl()}/api/v1/hotspot-files/${router.id}/login.html` : null,
    agentLines: agentInstallLines(router.name.slice(0, 60), { checkInUrl: agentUrl(agentKey), verifyTls: agentVerifyTls() }),
    generatedAt: now,
  });

  const ctx = systemContext(router.organizationId, "router:setup", meta.correlationId);
  await audit(ctx, { action: "router.setup_command.used", entityType: "router", entityId: router.id, metadata: { sourceIp: meta.ipAddress, credentialsRotated: true, radius: Boolean(radius) } });
  // Check the router a minute later, once the script has run.
  const op = await enqueueOperation({ type: "routers.healthcheck", organizationId: router.organizationId, payload: { routerId: router.id }, dedupeKey: `routers.healthcheck:${router.id}:setup:${now.getTime()}`, runAfter: new Date(now.getTime() + 60_000), maxAttempts: 1 });
  await dispatchOperation(op);
  logger.info({ routerId: router.id, correlationId: meta.correlationId }, "router setup script served");
  return { status: 200, body: script };
}
