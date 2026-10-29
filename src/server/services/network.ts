import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { requirePermission, systemContext, tenantWhere, type ActorContext, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import { dispatchOperation, enqueueOperation, PermanentError, RetryableError } from "@/server/jobs/operations";
import { networkAdapter, networkAdapterName, type ActiveSession, type NetworkAdapter, type OpResult, type SessionHint } from "@/server/integrations/network";
import { routerRateLimit, type RateSpec } from "@/lib/plans";
import { radiusActiveSessions, radiusConfigured, radiusRemoveUser, radiusUpsertUser } from "@/server/integrations/radius";
import { assertExecutable, openAlert, routerTarget } from "@/server/services/routers";
import { assertPlanAllowedOnRouter, planOpenAt } from "@/server/services/plan-rules";
import { actorType, actorUserId, lockRow, searchTerm } from "@/server/services/common";
import { logger } from "@/server/observability/logger";
import type { NetworkOperation, NetworkOperationStatus, Prisma, Router, Subscription } from "@/generated/prisma/client";

/**
 * Durable network operations.
 *
 * Every router/RADIUS change is a NetworkOperation row with an allowlisted type, non-secret params and a unique
 * idempotency key, created in the same transaction as the business change that requires it (e.g. a suspension).
 * A "network.execute" background operation runs it in the worker:
 * - transient failures (timeouts, refused connections, RADIUS DB unavailable) are retried with backoff,
 * - permanent failures (credentials rejected, router refused the change, policy violations) fail immediately,
 * - every attempt is recorded (append-only), and exhausted/permanent failures raise a RouterAlert.
 * A result counts as success only when the adapter reports success and, where supported, a read-back matches.
 * Billing state (Subscription.status) and network state (Subscription.networkStatus) are kept separate.
 */

export const NETWORK_OPERATION_TYPES = [
  "pppoe.enable",
  "pppoe.disable",
  "pppoe.remove",
  "session.disconnect",
  "hotspot.user.upsert",
  "profile.sync",
  "hotspot.access.enable",
  "hotspot.access.disable",
  "device.binding.enable",
  "device.binding.disable",
] as const;
export type NetworkOperationType = (typeof NETWORK_OPERATION_TYPES)[number];
/** Operations that set a subscription's access state; only the newest one decides its network status. */
const STATE_TYPES: NetworkOperationType[] = ["pppoe.enable", "pppoe.disable", "hotspot.access.enable", "hotspot.access.disable", "device.binding.enable", "device.binding.disable"];
const isEnableType = (t: string) => t.endsWith(".enable");
const TERMINAL: NetworkOperationStatus[] = ["SUCCEEDED", "SIMULATED", "FAILED", "CANCELLED"];
export const NETWORK_MAX_ATTEMPTS = 5;
const STALE_RUNNING_MS = 10 * 60_000;

export const OPERATION_LABEL: Record<NetworkOperationType, string> = {
  "pppoe.enable": "Enable PPPoE access",
  "pppoe.disable": "Disable PPPoE access",
  "pppoe.remove": "Remove PPPoE account",
  "session.disconnect": "Disconnect session",
  "hotspot.user.upsert": "Activate hotspot voucher",
  "profile.sync": "Push plan to router",
  "hotspot.access.enable": "Enable hotspot access",
  "hotspot.access.disable": "Disable hotspot access",
  "device.binding.enable": "Let device through (MAC)",
  "device.binding.disable": "Remove device access (MAC)",
};

/** How a subscription reaches the network: PPPoE secret, hotspot login, or a device bound by MAC. */
export type AccessKind = "pppoe" | "hotspot" | "device";

export function accessKindOf(serviceType: string, packageKind: string | null | undefined): AccessKind | null {
  if (serviceType === "PPPOE") return "pppoe";
  if (serviceType === "HOTSPOT") return packageKind === "DEVICE" ? "device" : "hotspot";
  return null;
}

function stateTypeFor(kind: AccessKind, desired: "enabled" | "disabled"): NetworkOperationType {
  const on = desired === "enabled";
  if (kind === "hotspot") return on ? "hotspot.access.enable" : "hotspot.access.disable";
  if (kind === "device") return on ? "device.binding.enable" : "device.binding.disable";
  return on ? "pppoe.enable" : "pppoe.disable";
}

/** Network passwords (PPPoE secrets, hotspot logins) are encrypted per subscription. */
export function sealNetworkPassword(subscriptionId: string, password: string): string {
  return encryptSecret(password, `pppoe:${subscriptionId}`);
}

export function openNetworkPassword(subscriptionId: string, envelope: string): string {
  return decryptSecret(envelope, `pppoe:${subscriptionId}`);
}

export const PPPOE_USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SESSION_USERNAME_RE = /^[A-Za-z0-9._@:-]{1,64}$/;

const desiredOf = (status: string): "enabled" | "disabled" => (status === "ACTIVE" ? "enabled" : "disabled");
const stateType = (desired: "enabled" | "disabled"): NetworkOperationType => (desired === "enabled" ? "pppoe.enable" : "pppoe.disable");
const pppoeAad = (subscriptionId: string) => `pppoe:${subscriptionId}`;

/** 12 characters from an unambiguous alphabet (no 0/O, 1/l/I). */
export function generatePppoePassword(length = 12): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ───────── Requesting operations ─────────

export interface RequestOperationInput {
  type: NetworkOperationType;
  routerId: string | null;
  subscriptionId?: string | null;
  subscriberId?: string | null;
  redemptionId?: string | null;
  params: Record<string, string | number | boolean | null>;
  idempotencyKey: string;
}

/**
 * Persist an operation and its execution job inside the caller's transaction. Same idempotency key → same row.
 * Newer enable/disable requests for the same subscription, router and username supersede queued older ones.
 */
export async function requestNetworkOperationTx(tx: Tx, ctx: ActorContext, input: RequestOperationInput): Promise<NetworkOperation> {
  if (!NETWORK_OPERATION_TYPES.includes(input.type)) throw new AppError("VALIDATION_ERROR", "This network operation is not allowed.");
  const organizationId = ctx.organizationId;
  const existing = await tx.networkOperation.findUnique({ where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: input.idempotencyKey } } });
  if (existing) return existing;
  const op = await tx.networkOperation.create({
    data: {
      organizationId,
      routerId: input.routerId,
      subscriptionId: input.subscriptionId ?? null,
      subscriberId: input.subscriberId ?? null,
      redemptionId: input.redemptionId ?? null,
      type: input.type,
      params: input.params,
      idempotencyKey: input.idempotencyKey,
      requestedById: actorUserId(ctx),
      requestedBy: actorType(ctx),
      maxAttempts: NETWORK_MAX_ATTEMPTS,
    },
  });
  if (input.type === "profile.sync") {
    // Only the newest version of a plan matters on a router.
    await tx.networkOperation.updateMany({
      where: { organizationId, routerId: input.routerId, type: "profile.sync", status: { in: ["QUEUED", "RETRYING"] }, id: { not: op.id }, params: { path: ["packageId"], equals: String(input.params.packageId ?? "") } },
      data: { status: "CANCELLED", resultDetail: "Superseded by a newer version of the plan", completedAt: new Date() },
    });
  }
  if (input.subscriptionId && STATE_TYPES.includes(input.type)) {
    await tx.networkOperation.updateMany({
      where: {
        organizationId,
        subscriptionId: input.subscriptionId,
        routerId: input.routerId,
        type: { in: STATE_TYPES },
        status: { in: ["QUEUED", "RETRYING"] },
        id: { not: op.id },
        params: { path: ["username"], equals: String(input.params.username ?? "") },
      },
      data: { status: "CANCELLED", resultDetail: "Superseded by a newer request", completedAt: new Date() },
    });
  }
  const bg = await enqueueOperation(
    { type: "network.execute", organizationId, payload: { networkOperationId: op.id }, dedupeKey: `network:${op.id}`, maxAttempts: NETWORK_MAX_ATTEMPTS + 3, correlationId: ctx.correlationId },
    tx,
  );
  return tx.networkOperation.update({ where: { id: op.id }, data: { backgroundOperationId: bg.id } });
}

/** Push queued operations to the job queue after the creating transaction committed (the DB sweeper is the fallback). */
export async function dispatchNetworkOperations(organizationId: string, filter: { subscriptionId?: string; ids?: string[] } = {}) {
  const ops = await db.networkOperation.findMany({
    where: { organizationId, status: "QUEUED", backgroundOperationId: { not: null }, ...(filter.subscriptionId ? { subscriptionId: filter.subscriptionId } : {}), ...(filter.ids ? { id: { in: filter.ids } } : {}) },
    select: { backgroundOperationId: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  if (!ops.length) return;
  const bgs = await db.backgroundOperation.findMany({ where: { id: { in: ops.map((o) => o.backgroundOperationId!) }, status: "PENDING" } });
  for (const bg of bgs) await dispatchOperation(bg);
}

/**
 * Subscription lifecycle hook (called inside applyActionTx): when the billing status changes what network access
 * should be (ACTIVE → enabled, anything else → disabled), queue the matching operation for provisioned subscriptions.
 */
export async function queueLifecycleNetworkTx(tx: Tx, ctx: ActorContext, before: Subscription, after: Subscription): Promise<NetworkOperation | null> {
  if (!after.networkRouterId || !after.networkUsername) return null;
  const pkg = await tx.package.findUnique({ where: { id: after.packageId }, select: { kind: true } });
  const kind = accessKindOf(after.serviceType, pkg?.kind);
  if (!kind) return null;
  const desired = desiredOf(after.status);
  const settled = desired === "enabled" ? ["ACTIVE", "SIMULATED_ACTIVE", "PENDING"] : ["DISABLED", "SIMULATED_DISABLED", "PENDING"];
  // Hotspot logins carry the period (router-side time and data limits), so a new period is pushed even when the
  // subscription stays active (e.g. a second purchase extends it).
  const newPeriod = kind !== "pppoe" && (after.currentPeriodEnd?.getTime() !== before.currentPeriodEnd?.getTime() || after.packageId !== before.packageId);
  if (desired === desiredOf(before.status) && settled.includes(after.networkStatus) && !(desired === "enabled" && newPeriod)) return null;
  const op = await requestNetworkOperationTx(tx, ctx, {
    type: stateTypeFor(kind, desired),
    routerId: after.networkRouterId,
    subscriptionId: after.id,
    subscriberId: after.subscriberId,
    params: {
      username: after.networkUsername,
      reason: newPeriod && desired === "enabled" ? "New period" : `Subscription ${after.status.toLowerCase()}`,
      ...(kind === "hotspot" && pkg?.kind === "DATA" && newPeriod ? { resetCounters: true } : {}),
    },
    idempotencyKey: `lifecycle:${after.id}:${randomUUID()}`,
  });
  await tx.subscription.update({ where: { id: after.id }, data: { networkStatus: "PENDING", networkUpdatedAt: new Date() } });
  return op;
}

// ───────── Subscription provisioning (staff) ─────────

export const provisionInput = z.object({
  routerId: z.uuid(),
  username: z.string().trim().toLowerCase().regex(PPPOE_USERNAME_RE, "3–64 characters: lowercase letters, digits, dot, dash or underscore").optional(),
  regeneratePassword: z.boolean().default(false),
});

export const deprovisionInput = z.object({ reason: z.string().trim().min(3).max(300) });

async function findSubscription(ctx: StaffContext, id: string) {
  const sub = await db.subscription.findFirst({ where: { id, ...tenantWhere(ctx) }, include: { subscriber: { select: { accountNumber: true, displayName: true } } } });
  if (!sub) throw notFound("subscription");
  return sub;
}

export async function provisionSubscriptionNetwork(ctx: StaffContext, subscriptionId: string, raw: z.input<typeof provisionInput>) {
  requirePermission(ctx, "network.operate");
  const input = provisionInput.parse(raw);
  const sub = await findSubscription(ctx, subscriptionId);
  if (sub.status === "CANCELLED") throw new AppError("INVALID_STATE", "Cancelled subscriptions cannot be provisioned.");
  if (sub.serviceType !== "PPPOE") throw new AppError("INVALID_STATE", "Only PPPoE subscriptions are provisioned on routers. Hotspot access uses vouchers.");
  const router = await db.router.findFirst({ where: { id: input.routerId, ...tenantWhere(ctx), archivedAt: null } });
  if (!router) throw notFound("router");
  if (!router.pppoeEnabled) throw new AppError("INVALID_STATE", "PPPoE is not enabled on this router.");
  await assertPlanAllowedOnRouter(db, sub.packageId, router.id);
  const username = input.username ?? sub.networkUsername ?? sub.subscriber.accountNumber.toLowerCase();
  if (!PPPOE_USERNAME_RE.test(username)) throw new AppError("VALIDATION_ERROR", "Choose a PPPoE username.", { fields: [{ path: "username", message: "Invalid username" }] });

  const result = await db
    .$transaction(async (tx) => {
      await lockRow(tx, "Subscription", sub.id);
      const cur = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      const taken = await tx.subscription.findFirst({ where: { organizationId: ctx.organizationId, networkUsername: username, id: { not: sub.id } }, select: { id: true } });
      if (taken) throw new AppError("CONFLICT", "This PPPoE username is already used by another subscription.", { fields: [{ path: "username", message: "Already in use" }] });
      const newPassword = !cur.networkPasswordEnc || input.regeneratePassword;
      const passwordEnc = newPassword ? encryptSecret(generatePppoePassword(), pppoeAad(sub.id)) : cur.networkPasswordEnc!;
      // Moving to another router or renaming: remove the old account so it cannot keep authenticating.
      const moved = Boolean(cur.networkRouterId && cur.networkUsername && (cur.networkRouterId !== router.id || cur.networkUsername !== username));
      if (moved) {
        await requestNetworkOperationTx(tx, ctx, {
          type: "pppoe.remove",
          routerId: cur.networkRouterId,
          subscriptionId: sub.id,
          subscriberId: sub.subscriberId,
          params: { username: cur.networkUsername, reason: "Moved to another router or username" },
          idempotencyKey: `provision:${sub.id}:${randomUUID()}:remove`,
        });
      }
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { networkRouterId: router.id, networkUsername: username, networkPasswordEnc: passwordEnc, networkStatus: "PENDING", networkUpdatedAt: new Date() },
      });
      const op = await requestNetworkOperationTx(tx, ctx, {
        type: stateType(desiredOf(updated.status)),
        routerId: router.id,
        subscriptionId: sub.id,
        subscriberId: sub.subscriberId,
        params: { username, reason: newPassword && !cur.networkPasswordEnc ? "Provisioned" : "Re-provisioned" },
        idempotencyKey: `provision:${sub.id}:${randomUUID()}`,
      });
      await tx.subscriberActivity.create({
        data: {
          organizationId: ctx.organizationId,
          subscriberId: sub.subscriberId,
          actorUserId: ctx.userId,
          type: "network.provisioned",
          message: `PPPoE access ${username} requested on ${router.name}`,
          metadata: { subscriptionId: sub.id, routerId: router.id, operationId: op.id },
        },
      });
      return { op, moved, newPassword };
    })
    .catch((err) => {
      if ((err as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "This PPPoE username is already in use.", { fields: [{ path: "username", message: "Already in use" }] });
      throw err;
    });
  await dispatchNetworkOperations(ctx.organizationId, { subscriptionId: sub.id });
  await audit(ctx, {
    action: "network.provision",
    entityType: "subscription",
    entityId: sub.id,
    metadata: { routerId: router.id, username, passwordGenerated: result.newPassword, movedFromPrevious: result.moved, operationId: result.op.id },
  });
  return { operation: publicOperation(result.op), username };
}

/** Reveal the PPPoE credentials for CPE setup. Audited; the response is never cached or stored. */
export async function revealNetworkCredentials(ctx: StaffContext, subscriptionId: string) {
  requirePermission(ctx, "network.operate");
  const sub = await findSubscription(ctx, subscriptionId);
  if (!sub.networkPasswordEnc || !sub.networkUsername) throw new AppError("INVALID_STATE", "This subscription has no network credentials.");
  const password = decryptSecret(sub.networkPasswordEnc, pppoeAad(sub.id));
  await audit(ctx, { action: "network.credentials.reveal", entityType: "subscription", entityId: sub.id, metadata: { username: sub.networkUsername } });
  return { username: sub.networkUsername, password };
}

/** Remove network access: queue removal of the account and clear the stored credentials. */
export async function deprovisionSubscriptionNetwork(ctx: StaffContext, subscriptionId: string, raw: z.input<typeof deprovisionInput>) {
  requirePermission(ctx, "network.operate");
  const { reason } = deprovisionInput.parse(raw);
  const sub = await findSubscription(ctx, subscriptionId);
  if (!sub.networkRouterId || !sub.networkUsername) throw new AppError("INVALID_STATE", "This subscription has no network access to remove.");
  const op = await db.$transaction(async (tx) => {
    await lockRow(tx, "Subscription", sub.id);
    const cur = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    if (!cur.networkRouterId || !cur.networkUsername) throw new AppError("INVALID_STATE", "This subscription has no network access to remove.");
    const removal = await requestNetworkOperationTx(tx, ctx, {
      type: "pppoe.remove",
      routerId: cur.networkRouterId,
      subscriptionId: sub.id,
      subscriberId: sub.subscriberId,
      params: { username: cur.networkUsername, reason },
      idempotencyKey: `deprovision:${sub.id}:${randomUUID()}`,
    });
    await tx.networkOperation.updateMany({
      where: { subscriptionId: sub.id, type: { in: STATE_TYPES }, status: { in: ["QUEUED", "RETRYING"] } },
      data: { status: "CANCELLED", resultDetail: "Network access was removed", completedAt: new Date() },
    });
    await tx.subscription.update({ where: { id: sub.id }, data: { networkRouterId: null, networkUsername: null, networkPasswordEnc: null, networkStatus: "NOT_PROVISIONED", networkUpdatedAt: new Date() } });
    return removal;
  });
  await dispatchNetworkOperations(ctx.organizationId, { ids: [op.id] });
  await audit(ctx, { action: "network.deprovision", entityType: "subscription", entityId: sub.id, metadata: { routerId: sub.networkRouterId, username: sub.networkUsername, reason, operationId: op.id } });
  return publicOperation(op);
}

export async function subscriptionNetwork(ctx: StaffContext, subscriptionId: string) {
  requirePermission(ctx, "network.read");
  const sub = await findSubscription(ctx, subscriptionId);
  const [router, operations, sessions] = await Promise.all([
    sub.networkRouterId ? db.router.findUnique({ where: { id: sub.networkRouterId }, select: { id: true, name: true, status: true, pppoeAuth: true } }) : null,
    db.networkOperation.findMany({ where: { subscriptionId: sub.id, organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 10 }),
    sub.networkUsername
      ? db.networkSession.findMany({ where: { organizationId: ctx.organizationId, username: sub.networkUsername, endedAt: null }, orderBy: { lastSeenAt: "desc" }, take: 5 })
      : Promise.resolve([]),
  ]);
  return {
    subscriptionId: sub.id,
    serviceType: sub.serviceType,
    provisioned: Boolean(sub.networkRouterId),
    router,
    username: sub.networkUsername,
    hasPassword: Boolean(sub.networkPasswordEnc),
    networkStatus: sub.networkStatus,
    networkUpdatedAt: sub.networkUpdatedAt,
    billingStatus: sub.status,
    operations: operations.map(publicOperation),
    sessions: sessions.map(publicSession),
    adapter: networkAdapterName(),
  };
}

// ───────── Staff-requested router operations (allowlisted) ─────────

export const routerOperationInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pppoe.sync"), subscriptionId: z.uuid() }),
  z.object({
    type: z.literal("session.disconnect"),
    kind: z.enum(["PPPOE", "HOTSPOT"]),
    username: z.string().trim().regex(SESSION_USERNAME_RE, "Enter the session's username"),
    reason: z.string().trim().max(300).optional(),
  }),
]);

export async function requestRouterOperation(ctx: StaffContext, routerId: string, input: z.infer<typeof routerOperationInput>) {
  requirePermission(ctx, "network.operate");
  const router = await db.router.findFirst({ where: { id: routerId, ...tenantWhere(ctx) } });
  if (!router) throw notFound("router");
  if (router.archivedAt) throw new AppError("INVALID_STATE", "Archived routers cannot run operations.");
  const op = await db.$transaction(async (tx) => {
    if (input.type === "pppoe.sync") {
      const sub = await tx.subscription.findFirst({ where: { id: input.subscriptionId, ...tenantWhere(ctx) } });
      if (!sub) throw notFound("subscription");
      if (sub.networkRouterId !== router.id || !sub.networkUsername) throw new AppError("INVALID_STATE", "This subscription is not provisioned on this router.");
      await lockRow(tx, "Subscription", sub.id);
      const created = await requestNetworkOperationTx(tx, ctx, {
        type: stateType(desiredOf(sub.status)),
        routerId: router.id,
        subscriptionId: sub.id,
        subscriberId: sub.subscriberId,
        params: { username: sub.networkUsername, reason: "Manual re-sync" },
        idempotencyKey: `staff:${randomUUID()}`,
      });
      await tx.subscription.update({ where: { id: sub.id }, data: { networkStatus: "PENDING", networkUpdatedAt: new Date() } });
      return created;
    }
    const sub = input.kind === "PPPOE" ? await tx.subscription.findFirst({ where: { organizationId: ctx.organizationId, networkUsername: input.username }, select: { id: true, subscriberId: true } }) : null;
    return requestNetworkOperationTx(tx, ctx, {
      type: "session.disconnect",
      routerId: router.id,
      subscriptionId: sub?.id ?? null,
      subscriberId: sub?.subscriberId ?? null,
      params: { kind: input.kind, username: input.username, reason: input.reason ?? null },
      idempotencyKey: `staff:${randomUUID()}`,
    });
  });
  await dispatchNetworkOperations(ctx.organizationId, { ids: [op.id] });
  await audit(ctx, { action: "network.operation.request", entityType: "network_operation", entityId: op.id, metadata: { type: op.type, routerId: router.id, params: op.params } });
  return publicOperation(op);
}

// ───────── Execution (worker) ─────────

type Outcome = OpResult | { cancelled: string };

const rateOf = (p: RateSpec) => routerRateLimit(p);

/** The router profile a plan uses (also referenced by PPPoE secrets and hotspot users). */
export function profileNameOf(pkg: { networkProfile: string | null; name: string }): string {
  return pkg.networkProfile || pkg.name;
}

async function performProfileSync(op: NetworkOperation, router: Router, adapter: NetworkAdapter, attempt: number): Promise<Outcome> {
  const params = (op.params ?? {}) as Record<string, unknown>;
  const pkg = await db.package.findFirst({ where: { id: String(params.packageId ?? ""), organizationId: op.organizationId } });
  if (!pkg) return { cancelled: "The plan no longer exists" };
  if (pkg.status === "ARCHIVED") return { cancelled: "The plan was archived" };
  const kind = pkg.serviceType === "PPPOE" ? "PPPOE" : "HOTSPOT";
  if ((kind === "PPPOE" && !router.pppoeEnabled) || (kind === "HOTSPOT" && !router.hotspotEnabled)) return { cancelled: `${kind === "PPPOE" ? "PPPoE" : "Hotspot"} is not enabled on this router` };
  const restricted = await db.packageRouter.findMany({ where: { packageId: pkg.id }, select: { routerId: true } });
  if (restricted.length && !restricted.some((r) => r.routerId === router.id)) return { cancelled: "The plan is restricted to other routers" };
  return adapter.upsertProfile(
    await routerTarget(router),
    { kind, name: profileNameOf(pkg), rateLimit: routerRateLimit(pkg), sharedUsers: kind === "HOTSPOT" ? (pkg.deviceLimit ?? 1) : null, comment: `cloudlink plan ${pkg.id}` },
    { attempt },
  );
}

async function performHotspot(op: NetworkOperation, router: Router | null, adapter: NetworkAdapter, attempt: number): Promise<Outcome> {
  const r = op.redemptionId ? await db.voucherRedemption.findUnique({ where: { id: op.redemptionId }, include: { voucher: { include: { batch: true } } } }) : null;
  if (!r) throw new PermanentError("Voucher redemption not found", "REDEMPTION_MISSING");
  const remaining = Math.floor((r.accessEndsAt.getTime() - Date.now()) / 1000);
  if (remaining <= 0) throw new PermanentError("The voucher's access period has already ended", "ACCESS_ENDED");
  const batch = r.voucher.batch;
  if (!router) {
    if (adapter.name === "mock") return { status: "SIMULATED", verified: null, detail: "Mock adapter: no hotspot router is registered. No router was changed." };
    throw new PermanentError("No hotspot router is assigned. Set the batch's router, or keep exactly one hotspot-enabled router.", "NO_HOTSPOT_ROUTER");
  }
  assertExecutable(router);
  const pkg = await db.package.findUnique({ where: { id: batch.packageId }, select: { networkProfile: true } });
  const code = decryptSecret(r.voucher.codeEncrypted, `voucher:${r.organizationId}`);
  return adapter.upsertHotspotUser(
    await routerTarget(router),
    { username: code, password: code, profile: pkg?.networkProfile || batch.packageName, uptimeLimitSeconds: remaining, macAddress: r.clientMac, comment: `cloudlink ${batch.batchNumber}` },
    { attempt },
  );
}

async function perform(op: NetworkOperation, attempt: number): Promise<Outcome> {
  const adapter = networkAdapter();
  if (adapter.name === "disabled") throw new PermanentError("Network automation is disabled for this deployment (NETWORK_ADAPTER=disabled).", "NETWORK_DISABLED");
  const params = (op.params ?? {}) as Record<string, unknown>;
  const router = op.routerId ? await db.router.findUnique({ where: { id: op.routerId } }) : null;
  if (op.routerId && !router) throw new PermanentError("The router no longer exists", "ROUTER_MISSING");
  if (op.type === "hotspot.user.upsert") return performHotspot(op, router, adapter, attempt);
  if (!router) throw new PermanentError("No router was specified", "ROUTER_MISSING");
  assertExecutable(router);
  if (op.type === "profile.sync") return performProfileSync(op, router, adapter, attempt);
  const target = await routerTarget(router);
  const x = { attempt };
  const viaRadius = router.pppoeAuth === "RADIUS" && adapter.name === "routeros";
  const username = String(params.username ?? "");

  switch (op.type as NetworkOperationType) {
    case "pppoe.enable":
    case "pppoe.disable": {
      const sub = op.subscriptionId
        ? await db.subscription.findUnique({
            where: { id: op.subscriptionId },
            include: {
              package: {
                select: { networkProfile: true, uploadKbps: true, downloadKbps: true, burstUploadKbps: true, burstDownloadKbps: true, burstThresholdUploadKbps: true, burstThresholdDownloadKbps: true, burstTimeSeconds: true },
              },
            },
          })
        : null;
      if (!sub || sub.networkRouterId !== router.id || sub.networkUsername !== username || !sub.networkPasswordEnc) {
        return { cancelled: "The subscription's network access changed after this operation was requested" };
      }
      const disabled = op.type === "pppoe.disable";
      const password = decryptSecret(sub.networkPasswordEnc, pppoeAad(sub.id));
      const profile = sub.package.networkProfile || sub.packageName;
      if (viaRadius) {
        const r = await radiusUpsertUser({ username, password, group: profile, rateLimit: rateOf(sub.package), disabled });
        const kicked = disabled ? await adapter.disconnectSession(target, "PPPOE", username, x) : null;
        return { status: "SUCCEEDED", verified: r.verified && (kicked ? kicked.verified !== false : true), detail: `${r.detail}${kicked ? `; ${kicked.detail}` : ""}` };
      }
      return adapter.upsertPppoeSecret(target, { username, password, profile, disabled, comment: `cloudlink ${sub.id}` }, x);
    }
    case "pppoe.remove": {
      if (viaRadius) {
        const r = await radiusRemoveUser(username);
        const kicked = await adapter.disconnectSession(target, "PPPOE", username, x);
        return { status: "SUCCEEDED", verified: r.verified && kicked.verified !== false, detail: `${r.detail}; ${kicked.detail}` };
      }
      return adapter.removePppoeSecret(target, username, x);
    }
    case "session.disconnect":
      return adapter.disconnectSession(target, params.kind === "HOTSPOT" ? "HOTSPOT" : "PPPOE", username, x);
    case "hotspot.access.enable":
    case "hotspot.access.disable":
    case "device.binding.enable":
    case "device.binding.disable": {
      const sub = op.subscriptionId
        ? await db.subscription.findUnique({ where: { id: op.subscriptionId }, include: { package: { select: { networkProfile: true, name: true, kind: true, dataQuotaMb: true } } } })
        : null;
      const enable = isEnableType(op.type);
      // Enabling must target the subscription's current router; disabling may also clean up a router it moved away from.
      if (!sub || sub.networkUsername !== username || (enable && sub.networkRouterId !== router.id)) return { cancelled: "The subscription's network access changed after this operation was requested" };
      if (op.type.startsWith("device.")) {
        if (!sub.networkMac) throw new PermanentError("The device's MAC address is missing", "DEVICE_MAC_MISSING");
        return adapter.setDeviceBinding(target, { macAddress: sub.networkMac, enabled: enable, comment: `cloudlink ${sub.id}` }, x);
      }
      if (!sub.networkPasswordEnc) throw new PermanentError("The hotspot login has no password", "HOTSPOT_PASSWORD_MISSING");
      const remaining = sub.currentPeriodEnd ? Math.floor((sub.currentPeriodEnd.getTime() - Date.now()) / 1000) : 0;
      if (enable && remaining <= 0) return { cancelled: "The paid period ended before access could be enabled" };
      return adapter.setHotspotAccess(
        target,
        {
          username,
          password: openNetworkPassword(sub.id, sub.networkPasswordEnc),
          profile: sub.package.networkProfile || sub.packageName,
          disabled: !enable,
          uptimeLimitSeconds: enable ? remaining : null,
          limitBytesTotal: sub.package.kind === "DATA" && sub.package.dataQuotaMb ? sub.package.dataQuotaMb * 1024 * 1024 : null,
          resetCounters: enable && params.resetCounters === true,
          comment: `cloudlink ${sub.id}`,
        },
        x,
      );
    }
    default:
      throw new PermanentError("This operation type is not allowed", "TYPE_NOT_ALLOWED");
  }
}

/** Apply the operation's outcome to the records that display it (subscription network status, voucher activation). */
async function applyOutcomeTx(tx: Tx, op: NetworkOperation, outcome: "succeeded" | "simulated" | "failed", detail: string) {
  if (op.type === "hotspot.user.upsert" && op.redemptionId) {
    const activationStatus = outcome === "succeeded" ? "ACTIVE" : outcome === "simulated" ? "SIMULATED" : "FAILED";
    await tx.voucherRedemption.update({
      where: { id: op.redemptionId },
      data: { activationStatus, activationDetail: detail.slice(0, 500), ...(outcome !== "failed" ? { activatedAt: new Date() } : {}) },
    });
  }
  if (op.subscriptionId && STATE_TYPES.includes(op.type as NetworkOperationType)) {
    // Only the newest state operation decides the displayed network status.
    const newer = await tx.networkOperation.count({ where: { subscriptionId: op.subscriptionId, type: { in: STATE_TYPES }, createdAt: { gt: op.createdAt }, status: { not: "CANCELLED" } } });
    if (newer === 0) {
      const enabled = isEnableType(op.type);
      const networkStatus = outcome === "failed" ? "ERROR" : outcome === "simulated" ? (enabled ? "SIMULATED_ACTIVE" : "SIMULATED_DISABLED") : enabled ? "ACTIVE" : "DISABLED";
      await tx.subscription.updateMany({ where: { id: op.subscriptionId, networkRouterId: op.routerId }, data: { networkStatus, networkUpdatedAt: new Date() } });
      if (enabled && outcome !== "failed") {
        // Activation time of self-service purchases: payment confirmed → access confirmed on the router.
        await tx.paymentAttempt.updateMany({ where: { subscriptionId: op.subscriptionId, status: "CONFIRMED", activatedAt: null }, data: { activatedAt: new Date() } });
      }
    }
  }
}

function errorParts(err: unknown): { retryable: boolean; code: string; message: string } {
  if (err instanceof PermanentError) return { retryable: false, code: err.code, message: err.message };
  if (err instanceof RetryableError) return { retryable: true, code: err.code, message: err.message };
  return { retryable: true, code: "UNEXPECTED", message: "Unexpected error while running the operation" };
}

/** Worker entry point for "network.execute". Throws RetryableError to be retried, PermanentError when final. */
export async function executeNetworkOperation(networkOperationId: string): Promise<{ status: string }> {
  const op = await db.networkOperation.findUnique({ where: { id: networkOperationId } });
  if (!op || TERMINAL.includes(op.status)) return { status: op?.status ?? "MISSING" };
  if (op.subscriptionId) {
    const earlier = await db.networkOperation.findFirst({
      where: { subscriptionId: op.subscriptionId, status: "RUNNING", id: { not: op.id }, createdAt: { lt: op.createdAt }, startedAt: { gt: new Date(Date.now() - STALE_RUNNING_MS) } },
      select: { id: true },
    });
    if (earlier) throw new RetryableError("Waiting for an earlier operation on this subscription", "WAITING_FOR_EARLIER");
  }
  const attempt = op.attempts + 1;
  const claimed = await db.networkOperation.updateMany({
    where: { id: op.id, status: { in: ["QUEUED", "RETRYING", "RUNNING"] }, attempts: op.attempts },
    data: { status: "RUNNING", attempts: attempt, startedAt: op.startedAt ?? new Date() },
  });
  if (!claimed.count) return { status: "SKIPPED" };
  const started = Date.now();
  const log = logger.child({ networkOperationId: op.id, type: op.type, attempt, organizationId: op.organizationId });

  let outcome: Outcome;
  try {
    outcome = await perform(op, attempt);
    if ("status" in outcome && outcome.verified === false) throw new RetryableError("The router accepted the change but reading it back did not match", "VERIFY_MISMATCH");
  } catch (err) {
    const { retryable, code, message } = errorParts(err);
    if (code === "UNEXPECTED") log.error({ err: err instanceof Error ? err.name : "unknown" }, "unexpected network operation error");
    const final = !retryable || attempt >= op.maxAttempts;
    await db.$transaction(async (tx) => {
      await tx.networkOperationAttempt.create({
        data: { operationId: op.id, attemptNumber: attempt, outcome: retryable ? "RETRYABLE_ERROR" : "PERMANENT_ERROR", errorCode: code, detail: message.slice(0, 500), durationMs: Date.now() - started },
      });
      await tx.networkOperation.update({
        where: { id: op.id },
        data: { status: final ? "FAILED" : "RETRYING", resultDetail: (final ? message : `Attempt ${attempt} failed: ${message}. Retrying automatically.`).slice(0, 500), ...(final ? { completedAt: new Date() } : {}) },
      });
      if (final) {
        await applyOutcomeTx(tx, op, "failed", message);
        await tx.routerAlert.updateMany({ where: { operationId: op.id, type: "OPERATION_STUCK", status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: new Date() } });
      }
    });
    log.warn({ code, final }, "network operation attempt failed");
    if (final) {
      const label = OPERATION_LABEL[op.type as NetworkOperationType] ?? op.type;
      await openAlert(op.organizationId, { routerId: op.routerId, operationId: op.id, type: "OPERATION_FAILED", severity: "critical", message: `${label} failed after ${attempt} attempt(s): ${message}`.slice(0, 300) });
      throw new PermanentError(message, code);
    }
    throw new RetryableError(message, code);
  }

  const now = new Date();
  if ("cancelled" in outcome) {
    const reason = outcome.cancelled;
    await db.$transaction([
      db.networkOperationAttempt.create({ data: { operationId: op.id, attemptNumber: attempt, outcome: "CANCELLED", detail: reason, durationMs: Date.now() - started } }),
      db.networkOperation.update({ where: { id: op.id }, data: { status: "CANCELLED", resultDetail: reason, completedAt: now } }),
    ]);
    return { status: "CANCELLED" };
  }
  const result = outcome;
  await db.$transaction(async (tx) => {
    await tx.networkOperationAttempt.create({
      data: { operationId: op.id, attemptNumber: attempt, outcome: result.status === "SIMULATED" ? "SIMULATED" : "SUCCESS", detail: result.detail.slice(0, 500), durationMs: Date.now() - started },
    });
    await tx.networkOperation.update({
      where: { id: op.id },
      data: { status: result.status, verification: result.verified === null ? "NOT_SUPPORTED" : "VERIFIED", resultDetail: result.detail.slice(0, 500), completedAt: now },
    });
    await tx.routerAlert.updateMany({ where: { operationId: op.id, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: now } });
    await applyOutcomeTx(tx, op, result.status === "SIMULATED" ? "simulated" : "succeeded", result.detail);
  });
  log.info({ status: result.status }, "network operation completed");
  return { status: result.status };
}

// ───────── Operation queries and staff actions ─────────

export function publicOperation(op: NetworkOperation) {
  return {
    id: op.id,
    type: op.type,
    label: OPERATION_LABEL[op.type as NetworkOperationType] ?? op.type,
    status: op.status,
    verification: op.verification,
    routerId: op.routerId,
    subscriptionId: op.subscriptionId,
    subscriberId: op.subscriberId,
    redemptionId: op.redemptionId,
    params: op.params,
    requestedBy: op.requestedBy,
    requestedById: op.requestedById,
    resultDetail: op.resultDetail,
    attempts: op.attempts,
    maxAttempts: op.maxAttempts,
    createdAt: op.createdAt,
    startedAt: op.startedAt,
    completedAt: op.completedAt,
    updatedAt: op.updatedAt,
  };
}

/** A router filter must name a router the caller can see (unknown or foreign ids are not found). */
async function assertRouterVisible(ctx: StaffContext, routerId: string) {
  const found = await db.router.findFirst({ where: { id: routerId, ...tenantWhere(ctx) }, select: { id: true } });
  if (!found) throw notFound("router");
}

/** Router ids the caller can see (null = all routers of the organization). */
async function visibleRouterIds(ctx: StaffContext): Promise<string[] | null> {
  if (!ctx.branchIds) return null;
  const rows = await db.router.findMany({ where: tenantWhere(ctx), select: { id: true } });
  return rows.map((r) => r.id);
}

export const operationListQuery = z.object({
  status: z.enum(["QUEUED", "RUNNING", "RETRYING", "SUCCEEDED", "SIMULATED", "FAILED", "CANCELLED", "ATTENTION", "ALL"]).default("ALL"),
  type: z.enum(NETWORK_OPERATION_TYPES).optional(),
  routerId: z.uuid().optional(),
  subscriptionId: z.uuid().optional(),
  /** Profile pushes of one plan. */
  packageId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listNetworkOperations(ctx: StaffContext, query: z.infer<typeof operationListQuery>) {
  requirePermission(ctx, "network.read");
  const visible = await visibleRouterIds(ctx);
  const where: Prisma.NetworkOperationWhereInput = {
    organizationId: ctx.organizationId,
    ...(visible ? { routerId: { in: visible } } : {}),
    ...(query.routerId ? { routerId: query.routerId } : {}),
    ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
    ...(query.packageId ? { type: "profile.sync", params: { path: ["packageId"], equals: query.packageId } } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status === "ATTENTION" ? { status: { in: ["FAILED", "RETRYING"] } } : query.status !== "ALL" ? { status: query.status } : {}),
  };
  if (query.routerId) await assertRouterVisible(ctx, query.routerId);
  const [rows, total, counts] = await Promise.all([
    db.networkOperation.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.networkOperation.count({ where }),
    db.networkOperation.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId, ...(visible ? { routerId: { in: visible } } : {}) }, _count: { _all: true } }),
  ]);
  const [routers, subscribers] = await Promise.all([
    db.router.findMany({ where: { id: { in: rows.map((r) => r.routerId).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } }),
    db.subscriber.findMany({ where: { id: { in: rows.map((r) => r.subscriberId).filter((x): x is string => Boolean(x)) } }, select: { id: true, displayName: true, accountNumber: true } }),
  ]);
  return {
    rows: rows.map((op) => ({ ...publicOperation(op), routerName: routers.find((r) => r.id === op.routerId)?.name ?? null, subscriber: subscribers.find((s) => s.id === op.subscriberId) ?? null })),
    total,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<NetworkOperationStatus, number>>,
  };
}

async function findOperation(ctx: StaffContext, id: string) {
  const op = await db.networkOperation.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!op) throw notFound("network operation");
  const visible = await visibleRouterIds(ctx);
  if (visible && (!op.routerId || !visible.includes(op.routerId))) throw notFound("network operation");
  return op;
}

export async function getNetworkOperation(ctx: StaffContext, id: string) {
  requirePermission(ctx, "network.read");
  const op = await findOperation(ctx, id);
  const [attempts, router, subscriber, alerts] = await Promise.all([
    db.networkOperationAttempt.findMany({ where: { operationId: op.id }, orderBy: { attemptNumber: "asc" } }),
    op.routerId ? db.router.findUnique({ where: { id: op.routerId }, select: { id: true, name: true, host: true } }) : null,
    op.subscriberId ? db.subscriber.findUnique({ where: { id: op.subscriberId }, select: { id: true, displayName: true, accountNumber: true } }) : null,
    db.routerAlert.findMany({ where: { operationId: op.id }, orderBy: { createdAt: "desc" } }),
  ]);
  return { ...publicOperation(op), attemptsLog: attempts, router, subscriber, alerts, adapter: networkAdapterName() };
}

export async function retryNetworkOperation(ctx: StaffContext, id: string) {
  requirePermission(ctx, "network.operate");
  const op = await findOperation(ctx, id);
  if (op.status !== "FAILED") throw new AppError("INVALID_STATE", "Only failed operations can be retried.");
  if (op.attempts >= 15) throw new AppError("INVALID_STATE", "This operation reached the retry limit. Request a new operation instead.");
  if (op.subscriptionId && STATE_TYPES.includes(op.type as NetworkOperationType)) {
    const newer = await db.networkOperation.count({ where: { subscriptionId: op.subscriptionId, type: { in: STATE_TYPES }, createdAt: { gt: op.createdAt }, status: { not: "CANCELLED" } } });
    if (newer) throw new AppError("INVALID_STATE", "A newer operation exists for this subscription. Retrying this one would apply an outdated state.");
  }
  const { updated, bg } = await db.$transaction(async (tx) => {
    const bg = await enqueueOperation(
      { type: "network.execute", organizationId: ctx.organizationId, payload: { networkOperationId: op.id }, dedupeKey: `network:${op.id}:retry:${op.attempts}`, maxAttempts: NETWORK_MAX_ATTEMPTS + 3, correlationId: ctx.correlationId },
      tx,
    );
    const updated = await tx.networkOperation.update({
      where: { id: op.id },
      data: { status: "QUEUED", maxAttempts: Math.min(20, op.attempts + NETWORK_MAX_ATTEMPTS), completedAt: null, resultDetail: "Retry requested by staff", backgroundOperationId: bg.id },
    });
    if (op.subscriptionId && STATE_TYPES.includes(op.type as NetworkOperationType)) {
      await tx.subscription.updateMany({ where: { id: op.subscriptionId, networkRouterId: op.routerId }, data: { networkStatus: "PENDING", networkUpdatedAt: new Date() } });
    }
    if (op.redemptionId) await tx.voucherRedemption.update({ where: { id: op.redemptionId }, data: { activationStatus: "PENDING", activationDetail: "Retry requested by staff" } });
    return { updated, bg };
  });
  await dispatchOperation(bg);
  await audit(ctx, { action: "network.operation.retry", entityType: "network_operation", entityId: op.id, metadata: { type: op.type, previousAttempts: op.attempts } });
  return publicOperation(updated);
}

export const cancelOperationInput = z.object({ reason: z.string().trim().min(3).max(300) });

export async function cancelNetworkOperation(ctx: StaffContext, id: string, raw: z.input<typeof cancelOperationInput>) {
  requirePermission(ctx, "network.operate");
  const { reason } = cancelOperationInput.parse(raw);
  const op = await findOperation(ctx, id);
  if (op.status !== "QUEUED" && op.status !== "RETRYING") throw new AppError("INVALID_STATE", "Only queued or retrying operations can be cancelled.");
  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const res = await tx.networkOperation.updateMany({ where: { id: op.id, status: { in: ["QUEUED", "RETRYING"] } }, data: { status: "CANCELLED", resultDetail: `Cancelled by staff: ${reason}`.slice(0, 500), completedAt: now } });
    if (!res.count) throw new AppError("INVALID_STATE", "The operation started running and can no longer be cancelled.");
    if (op.redemptionId) await tx.voucherRedemption.update({ where: { id: op.redemptionId }, data: { activationStatus: "FAILED", activationDetail: "Activation cancelled by staff" } });
    if (op.subscriptionId && STATE_TYPES.includes(op.type as NetworkOperationType)) {
      const newer = await tx.networkOperation.count({ where: { subscriptionId: op.subscriptionId, type: { in: STATE_TYPES }, createdAt: { gt: op.createdAt }, status: { not: "CANCELLED" } } });
      if (!newer) await tx.subscription.updateMany({ where: { id: op.subscriptionId, networkRouterId: op.routerId }, data: { networkStatus: "ERROR", networkUpdatedAt: now } });
    }
    await tx.routerAlert.updateMany({ where: { operationId: op.id, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: now } });
    return tx.networkOperation.findUniqueOrThrow({ where: { id: op.id } });
  });
  await audit(ctx, { action: "network.operation.cancel", entityType: "network_operation", entityId: op.id, metadata: { type: op.type, reason } });
  return publicOperation(updated);
}

// ───────── Sessions ─────────

export const sessionListQuery = z.object({
  routerId: z.uuid().optional(),
  kind: z.enum(["PPPOE", "HOTSPOT"]).optional(),
  state: z.enum(["active", "ended", "all"]).default("active"),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

function publicSession(s: Prisma.NetworkSessionGetPayload<object>) {
  return { ...s, bytesIn: s.bytesIn?.toString() ?? null, bytesOut: s.bytesOut?.toString() ?? null };
}

export async function listNetworkSessions(ctx: StaffContext, query: z.infer<typeof sessionListQuery>) {
  requirePermission(ctx, "network.read");
  const visible = await visibleRouterIds(ctx);
  if (query.routerId) await assertRouterVisible(ctx, query.routerId);
  const q = searchTerm(query.q);
  const where: Prisma.NetworkSessionWhereInput = {
    organizationId: ctx.organizationId,
    ...(visible ? { routerId: { in: visible } } : {}),
    ...(query.routerId ? { routerId: query.routerId } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.state === "active" ? { endedAt: null } : query.state === "ended" ? { endedAt: { not: null } } : {}),
    ...(q ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { address: { contains: q } }, { macAddress: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.networkSession.findMany({ where, orderBy: [{ endedAt: { sort: "desc", nulls: "first" } }, { lastSeenAt: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.networkSession.count({ where }),
  ]);
  const [routers, subscribers, lastSync, online] = await Promise.all([
    db.router.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.routerId))] } }, select: { id: true, name: true } }),
    db.subscriber.findMany({ where: { id: { in: rows.map((r) => r.subscriberId).filter((x): x is string => Boolean(x)) } }, select: { id: true, displayName: true, accountNumber: true } }),
    lastSessionSync(ctx.organizationId),
    db.networkSession.groupBy({ by: ["kind"], where: { organizationId: ctx.organizationId, endedAt: null, ...(visible ? { routerId: { in: visible } } : {}) }, _count: { _all: true } }),
  ]);
  const count = (kind: string) => online.find((o) => o.kind === kind)?._count._all ?? 0;
  return {
    rows: rows.map((s) => ({ ...publicSession(s), routerName: routers.find((r) => r.id === s.routerId)?.name ?? null, subscriber: subscribers.find((x) => x.id === s.subscriberId) ?? null })),
    total,
    online: { pppoe: count("PPPOE"), hotspot: count("HOTSPOT") },
    lastSyncedAt: lastSync,
    adapter: networkAdapterName(),
  };
}

export async function requestSessionRefresh(ctx: StaffContext) {
  requirePermission(ctx, "network.read");
  const bucket = Math.floor(Date.now() / 30_000);
  const op = await enqueueOperation({ type: "network.sync_sessions", organizationId: ctx.organizationId, payload: { manual: true }, dedupeKey: `network.sync_sessions:${ctx.organizationId}:manual:${bucket}`, maxAttempts: 1, correlationId: ctx.correlationId });
  await dispatchOperation(op);
  return { queued: true, operationId: op.id };
}

/** When the last successful session sync finished (scheduled or requested), or null if never. */
export async function lastSessionSync(organizationId: string): Promise<Date | null> {
  const op = await db.backgroundOperation.findFirst({ where: { organizationId, type: "network.sync_sessions", status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true } });
  return op?.finishedAt ?? null;
}

/** Mock adapter only: who Cloudlink has (simulated as) enabled on this router, so sessions can be simulated for them. */
async function simulationHint(router: Router): Promise<SessionHint> {
  const now = new Date();
  const [subscriptions, redemptions] = await Promise.all([
    db.subscription.findMany({
      where: { organizationId: router.organizationId, networkRouterId: router.id, networkStatus: "SIMULATED_ACTIVE" },
      select: { id: true, serviceType: true, networkUsername: true, networkMac: true, currentPeriodStart: true, currentPeriodEnd: true, package: { select: { kind: true } } },
    }),
    db.voucherRedemption.findMany({ where: { organizationId: router.organizationId, activationStatus: "SIMULATED", accessEndsAt: { gt: now } }, include: { voucher: { select: { codeHint: true } } }, take: 500 }),
  ]);
  const onRouter = redemptions.length
    ? new Set((await db.networkOperation.findMany({ where: { routerId: router.id, type: "hotspot.user.upsert", redemptionId: { in: redemptions.map((r) => r.id) } }, select: { redemptionId: true } })).map((o) => o.redemptionId))
    : new Set<string | null>();
  const kindOf = (s: (typeof subscriptions)[number]) => accessKindOf(s.serviceType, s.package.kind);
  const period = (s: (typeof subscriptions)[number]) => ({ since: s.currentPeriodStart ?? now, until: s.currentPeriodEnd ?? now });
  return {
    pppoe: subscriptions.filter((s) => kindOf(s) === "pppoe").map((s) => s.networkUsername).filter((u): u is string => Boolean(u)),
    hotspot: [
      // The real hotspot username of a voucher is its code; the simulation never stores codes, only the hint.
      ...redemptions.filter((r) => onRouter.has(r.id)).map((r) => ({ id: r.id, username: `voucher …${r.voucher.codeHint}`, macAddress: r.clientMac, address: r.clientIp, since: r.activatedAt ?? r.createdAt, until: r.accessEndsAt })),
      ...subscriptions.filter((s) => kindOf(s) === "hotspot" && s.networkUsername).map((s) => ({ id: s.id, username: s.networkUsername!, macAddress: s.networkMac, address: null, ...period(s) })),
    ],
    bindings: subscriptions.filter((s) => kindOf(s) === "device" && s.networkMac).map((s) => ({ id: s.id, macAddress: s.networkMac!, ...period(s) })),
  };
}

async function routerSessions(router: Router, adapter: NetworkAdapter): Promise<{ sessions: ActiveSession[]; source: string }> {
  const target = await routerTarget(router);
  if (adapter.name === "mock") return { sessions: await adapter.listSessions(target, await simulationHint(router)), source: "mock" };
  if (router.pppoeAuth === "RADIUS" && adapter.name === "routeros" && radiusConfigured()) {
    const radius = await radiusActiveSessions(router.host);
    const hotspot = router.hotspotEnabled ? (await adapter.listSessions(target)).filter((s) => s.kind === "HOTSPOT") : [];
    return { sessions: [...radius, ...hotspot], source: "radius_accounting" };
  }
  return { sessions: await adapter.listSessions(target), source: "router_api" };
}

/** Worker: pull active sessions from every router (or RADIUS accounting) and close sessions no longer present. */
export async function syncNetworkSessions(organizationId: string) {
  const routers = await db.router.findMany({ where: { organizationId, archivedAt: null } });
  const adapter = networkAdapter();
  let seen = 0;
  let failed = 0;
  for (const router of routers) {
    const syncStart = new Date();
    let result: { sessions: ActiveSession[]; source: string };
    try {
      assertExecutable(router);
      result = await routerSessions(router, adapter);
    } catch (err) {
      failed++;
      logger.warn({ routerId: router.id, organizationId, code: (err as { code?: string }).code }, "session sync failed for router");
      continue; // unknown state: keep existing sessions open rather than guessing
    }
    // Owners: PPPoE and hotspot logins by username, bound devices by MAC (voucher logins have no subscriber).
    const usernames = [...new Set(result.sessions.filter((s) => s.kind !== "BINDING").map((s) => s.username))];
    const macs = [...new Set(result.sessions.filter((s) => s.kind === "BINDING" && s.macAddress).map((s) => s.macAddress!.toUpperCase()))];
    const owners = usernames.length || macs.length
      ? await db.subscription.findMany({
          where: { organizationId, OR: [...(usernames.length ? [{ networkUsername: { in: usernames } }] : []), ...(macs.length ? [{ networkMac: { in: macs }, status: { not: "CANCELLED" as const } }] : [])] },
          select: { networkUsername: true, networkMac: true, subscriberId: true },
        })
      : [];
    for (const s of result.sessions) {
      const subscriberId =
        s.kind === "BINDING"
          ? (owners.find((o) => o.networkMac && o.networkMac === s.macAddress?.toUpperCase())?.subscriberId ?? null)
          : (owners.find((o) => o.networkUsername === s.username)?.subscriberId ?? null);
      const startedAt = s.startedAt ?? (s.uptimeSeconds !== undefined ? new Date(syncStart.getTime() - s.uptimeSeconds * 1000) : null);
      await db.networkSession.upsert({
        where: { routerId_kind_externalId: { routerId: router.id, kind: s.kind, externalId: s.externalId } },
        create: {
          organizationId,
          routerId: router.id,
          subscriberId,
          kind: s.kind,
          username: s.username,
          externalId: s.externalId,
          address: s.address ?? null,
          macAddress: s.macAddress ?? null,
          uptimeSeconds: s.uptimeSeconds ?? null,
          bytesIn: s.bytesIn ?? null,
          bytesOut: s.bytesOut ?? null,
          source: result.source,
          startedAt,
          lastSeenAt: syncStart,
        },
        update: { subscriberId, username: s.username, address: s.address ?? null, uptimeSeconds: s.uptimeSeconds ?? null, bytesIn: s.bytesIn ?? null, bytesOut: s.bytesOut ?? null, lastSeenAt: syncStart },
      });
      seen++;
    }
    // Close sessions that disappeared. Router ids are reused by RouterOS, so ended rows get a suffix that frees the id.
    await db.$executeRaw`
      UPDATE "NetworkSession"
      SET "endedAt" = ${syncStart}, "externalId" = "externalId" || '#ended-' || floor(extract(epoch from ${syncStart}::timestamptz))::text
      WHERE "routerId" = ${router.id}::uuid AND "endedAt" IS NULL AND "lastSeenAt" < ${syncStart}`;
  }
  return { routers: routers.length, sessions: seen, failed };
}

// ───────── Monitoring (worker) ─────────

/** Raise OPERATION_STUCK alerts for operations that are not progressing. */
export async function monitorNetworkOperations(organizationId: string, now = new Date()) {
  const stuck = await db.networkOperation.findMany({
    where: {
      organizationId,
      OR: [
        { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
        { status: { in: ["QUEUED", "RETRYING"] }, updatedAt: { lt: new Date(now.getTime() - 30 * 60_000) } },
      ],
    },
    take: 200,
  });
  for (const op of stuck) {
    const label = OPERATION_LABEL[op.type as NetworkOperationType] ?? op.type;
    await openAlert(organizationId, { routerId: op.routerId, operationId: op.id, type: "OPERATION_STUCK", severity: "warning", message: `${label} has been ${op.status.toLowerCase()} since ${op.updatedAt.toISOString()}` });
  }
  return { stuck: stuck.length };
}

/**
 * Scheduled plans (e.g. a night plan): access is on only inside the plan's time window. Runs every minute.
 * Only settled states are flipped; pending or failed operations are left to the normal retry rules.
 */
export async function enforcePlanSchedules(organizationId: string, now = new Date()) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
  const subs = await db.subscription.findMany({
    where: { organizationId, status: "ACTIVE", networkRouterId: { not: null }, networkUsername: { not: null }, package: { scheduleEnabled: true } },
    include: { package: { select: { kind: true, scheduleEnabled: true, scheduleStartMinute: true, scheduleEndMinute: true, scheduleDays: true } } },
    take: 2000,
  });
  const ctx = systemContext(organizationId, "worker:schedules", `schedules:${now.toISOString()}`);
  const bucket = Math.floor(now.getTime() / 60_000);
  const ids: string[] = [];
  for (const s of subs) {
    const kind = accessKindOf(s.serviceType, s.package.kind);
    if (!kind) continue;
    const open = planOpenAt(s.package, now, org.timezone);
    const on = s.networkStatus === "ACTIVE" || s.networkStatus === "SIMULATED_ACTIVE";
    const off = s.networkStatus === "DISABLED" || s.networkStatus === "SIMULATED_DISABLED";
    if ((open && !off) || (!open && !on)) continue;
    const op = await db.$transaction(async (tx) => {
      await lockRow(tx, "Subscription", s.id);
      const cur = await tx.subscription.findUniqueOrThrow({ where: { id: s.id } });
      if (cur.status !== "ACTIVE" || cur.networkStatus !== s.networkStatus || !cur.networkRouterId || !cur.networkUsername) return null;
      const created = await requestNetworkOperationTx(tx, ctx, {
        type: stateTypeFor(kind, open ? "enabled" : "disabled"),
        routerId: cur.networkRouterId,
        subscriptionId: cur.id,
        subscriberId: cur.subscriberId,
        params: { username: cur.networkUsername, reason: open ? "Plan time window opened" : "Plan time window closed" },
        idempotencyKey: `schedule:${cur.id}:${open ? "open" : "close"}:${bucket}`,
      });
      await tx.subscription.update({ where: { id: cur.id }, data: { networkStatus: "PENDING", networkUpdatedAt: now } });
      return created;
    });
    if (op) ids.push(op.id);
  }
  if (ids.length) await dispatchNetworkOperations(organizationId, { ids });
  return { checked: subs.length, switched: ids.length };
}

/** Legacy "hotspot.activate" jobs (queued before network operations existed) become network operations. */
export async function ensureHotspotOperation(redemptionId: string) {
  const r = await db.voucherRedemption.findUnique({ where: { id: redemptionId }, include: { voucher: { include: { batch: { select: { routerId: true } } } } } });
  if (!r || r.activationStatus !== "PENDING") return;
  const routerId = r.voucher.batch.routerId ?? (await defaultHotspotRouterId(db, r.organizationId));
  const ctx = { kind: "system" as const, organizationId: r.organizationId, actor: "worker:hotspot", correlationId: redemptionId, ipAddress: null, userAgent: null };
  const op = await db.$transaction((tx) => requestNetworkOperationTx(tx, ctx, { type: "hotspot.user.upsert", routerId, redemptionId, params: { batchId: r.batchId }, idempotencyKey: `hotspot:${redemptionId}` }));
  await dispatchNetworkOperations(r.organizationId, { ids: [op.id] });
}

/** The organization's hotspot router when a batch does not name one: the only hotspot-enabled router, if exactly one. */
export async function defaultHotspotRouterId(client: Tx | typeof db, organizationId: string): Promise<string | null> {
  const routers = await client.router.findMany({ where: { organizationId, hotspotEnabled: true, archivedAt: null }, select: { id: true }, take: 2 });
  return routers.length === 1 ? routers[0]!.id : null;
}
