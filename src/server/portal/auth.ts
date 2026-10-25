import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { AppError, notFound } from "@/server/errors";
import { getDummyHash, hashPassword, PASSWORD_MIN_LENGTH, randomToken, sha256, verifyPassword } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS, resetRateLimit } from "@/server/security/rate-limit";
import { normalizePhone } from "@/server/domain/contact";
import { audit, auditAnonymous } from "@/server/audit/audit";
import { requirePermission, tenantWhere, type CustomerContext, type RequestMeta, type StaffContext } from "@/server/auth/context";
import { queueSubscriberNotificationTx } from "@/server/services/notifications";

export const PORTAL_COOKIE = process.env.APP_ENV === "production" ? "__Host-cloudlink_portal" : "cloudlink_portal";
const PORTAL_SESSION_HOURS = 8;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_FAILED = 5;

export const portalLoginInput = z.object({
  organization: z.string().trim().toLowerCase().min(1).max(60),
  identifier: z.string().trim().min(3).max(60), // phone or account number
  password: z.string().min(1).max(256),
});

export const portalActivateInput = z.object({
  token: z.string().min(20).max(128),
  password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`).max(256),
});

const genericFailure = () => new AppError("UNAUTHENTICATED", "The details you entered are incorrect, or portal access is not set up for this account.");

export function inviteLink(slug: string, token: string): string {
  return `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/portal/${slug}/activate?token=${encodeURIComponent(token)}`;
}

/** Customer login with phone number or account number. Throttled, lockout after repeated failures, generic errors. */
export async function portalLogin(input: z.infer<typeof portalLoginInput>, meta: RequestMeta) {
  await consumeRateLimit(RATE_LIMITS.loginByIp, `portal:${meta.ipAddress ?? "unknown"}`);
  const key = `${input.organization}:${input.identifier.toLowerCase()}`;
  await consumeRateLimit(RATE_LIMITS.loginByEmail, `portal:${key}`);

  const org = await db.organization.findUnique({ where: { slug: input.organization }, select: { id: true, status: true } });
  const phone = normalizePhone(input.identifier);
  let account = null;
  if (org) {
    const byAccountNumber = await db.subscriber.findFirst({ where: { organizationId: org.id, accountNumber: input.identifier.toUpperCase() }, select: { id: true } });
    const or: Array<{ loginPhone: string } | { subscriberId: string }> = [];
    if (phone) or.push({ loginPhone: phone });
    if (byAccountNumber) or.push({ subscriberId: byAccountNumber.id });
    account = or.length ? await db.customerAccount.findFirst({ where: { organizationId: org.id, OR: or } }) : null;
  }

  if (!org || org.status !== "ACTIVE" || !account || !account.passwordHash) {
    await verifyPassword(input.password, await getDummyHash());
    await auditAnonymous({ action: "portal.login_failed", organizationId: org?.id ?? null, metadata: { reason: account ? "not_activated" : "unknown" }, ...meta });
    throw genericFailure();
  }
  if (account.lockedUntil && account.lockedUntil > new Date()) {
    await auditAnonymous({ action: "portal.login_failed", organizationId: org.id, entityType: "customer_account", entityId: account.id, metadata: { reason: "locked" }, ...meta });
    throw genericFailure();
  }
  const ok = await verifyPassword(input.password, account.passwordHash);
  if (!ok) {
    const failed = account.failedLogins + 1;
    await db.customerAccount.update({ where: { id: account.id }, data: failed >= MAX_FAILED ? { failedLogins: 0, lockedUntil: new Date(Date.now() + 15 * 60_000) } : { failedLogins: failed } });
    await auditAnonymous({ action: failed >= MAX_FAILED ? "portal.account_locked" : "portal.login_failed", organizationId: org.id, entityType: "customer_account", entityId: account.id, metadata: { reason: "bad_password" }, ...meta });
    throw genericFailure();
  }
  if (account.status !== "ACTIVE") {
    await auditAnonymous({ action: "portal.login_failed", organizationId: org.id, entityType: "customer_account", entityId: account.id, metadata: { reason: account.status.toLowerCase() }, ...meta });
    throw genericFailure();
  }
  await db.customerAccount.update({ where: { id: account.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await resetRateLimit(RATE_LIMITS.loginByEmail, `portal:${key}`);
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_HOURS * 3_600_000);
  const session = await db.customerSession.create({
    data: { tokenHash: sha256(token), customerAccountId: account.id, organizationId: org.id, ipAddress: meta.ipAddress?.slice(0, 64), userAgent: meta.userAgent?.slice(0, 256), expiresAt },
  });
  await auditAnonymous({ action: "portal.login", organizationId: org.id, entityType: "customer_session", entityId: session.id, metadata: { customerAccountId: account.id }, ...meta });
  return { token, expiresAt };
}

export async function resolveCustomerContext(token: string | undefined, meta: RequestMeta): Promise<CustomerContext | null> {
  if (!token || token.length > 128) return null;
  const session = await db.customerSession.findUnique({ where: { tokenHash: sha256(token) }, include: { account: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.account.status !== "ACTIVE") return null;
  const [org, subscriber] = await Promise.all([
    db.organization.findUnique({ where: { id: session.organizationId } }),
    db.subscriber.findUnique({ where: { id: session.account.subscriberId }, select: { displayName: true, status: true, organizationId: true } }),
  ]);
  if (!org || org.status !== "ACTIVE" || !subscriber || subscriber.status === "ARCHIVED" || subscriber.organizationId !== org.id) return null;
  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    await db.customerSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return {
    kind: "customer",
    ...meta,
    organizationId: org.id,
    organization: { id: org.id, name: org.name, slug: org.slug, currency: org.currency, timezone: org.timezone },
    subscriberId: session.account.subscriberId,
    customerAccountId: session.account.id,
    sessionId: session.id,
    displayName: subscriber.displayName,
  };
}

export async function portalLogout(ctx: CustomerContext) {
  await db.customerSession.updateMany({ where: { id: ctx.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(ctx, { action: "portal.logout", entityType: "customer_session", entityId: ctx.sessionId });
}

/** Set the password from a single-use invite token. */
export async function activatePortalAccount(input: z.infer<typeof portalActivateInput>, meta: RequestMeta) {
  await consumeRateLimit(RATE_LIMITS.loginByIp, `portal-activate:${meta.ipAddress ?? "unknown"}`);
  const account = await db.customerAccount.findUnique({ where: { inviteTokenHash: sha256(input.token) } });
  if (!account || !account.inviteExpiresAt || account.inviteExpiresAt < new Date() || account.status === "DISABLED") {
    throw new AppError("VALIDATION_ERROR", "This link is invalid or has expired. Ask your provider for a new invite.");
  }
  const org = await db.organization.findUniqueOrThrow({ where: { id: account.organizationId }, select: { slug: true } });
  await db.$transaction(async (tx) => {
    await tx.customerAccount.update({
      where: { id: account.id },
      data: { passwordHash: await hashPassword(input.password), status: "ACTIVE", inviteTokenHash: null, inviteExpiresAt: null, activatedAt: account.activatedAt ?? new Date(), failedLogins: 0, lockedUntil: null },
    });
    await tx.customerSession.updateMany({ where: { customerAccountId: account.id, revokedAt: null }, data: { revokedAt: new Date() } }); // password changed
  });
  await auditAnonymous({ action: "portal.activated", organizationId: account.organizationId, entityType: "customer_account", entityId: account.id, ...meta });
  return { organization: org.slug };
}

// ───────── Staff actions on portal access ─────────

/** Mint a fresh invite token (invalidating earlier ones). Returns the plaintext token once; only its hash is stored. */
export async function mintInviteToken(customerAccountId: string): Promise<string> {
  const token = randomToken(32);
  await db.customerAccount.update({ where: { id: customerAccountId }, data: { inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
  return token;
}

async function ensureAccount(ctx: StaffContext, subscriberId: string) {
  const sub = await db.subscriber.findFirst({ where: { id: subscriberId, ...tenantWhere(ctx) }, select: { id: true, phone: true, status: true } });
  if (!sub) throw notFound("subscriber");
  if (sub.status === "ARCHIVED") throw new AppError("INVALID_STATE", "Archived subscribers cannot use the portal.");
  const clash = await db.customerAccount.findFirst({ where: { organizationId: ctx.organizationId, loginPhone: sub.phone, subscriberId: { not: sub.id } }, select: { id: true } });
  if (clash) throw new AppError("CONFLICT", "Another subscriber already uses this phone number for portal login. Update one of the phone numbers first.");
  return db.customerAccount.upsert({
    where: { subscriberId: sub.id },
    update: { loginPhone: sub.phone },
    create: { organizationId: ctx.organizationId, subscriberId: sub.id, loginPhone: sub.phone, status: "INVITED" },
  });
}

/**
 * Send a portal invite by SMS/email. The link token is minted by the worker at send time,
 * so it never sits in the database in plaintext.
 */
export async function sendPortalInvite(ctx: StaffContext, subscriberId: string) {
  requirePermission(ctx, "subscribers.write");
  const account = await ensureAccount(ctx, subscriberId);
  if (account.status === "DISABLED") throw new AppError("INVALID_STATE", "Portal access is disabled for this subscriber. Enable it first.");
  const queued = await db.$transaction((tx) =>
    queueSubscriberNotificationTx(tx, ctx.organizationId, { subscriberId, key: "portal.invite", vars: { link: "{{link}}" }, dedupeBase: `portal.invite:${account.id}:${Date.now()}` }),
  );
  await audit(ctx, { action: "portal.invite_sent", entityType: "subscriber", entityId: subscriberId, metadata: { channels: queued } });
  return { queued };
}

/** Generate a link for staff to hand over directly (shown once, never stored in plaintext). */
export async function createPortalInviteLink(ctx: StaffContext, subscriberId: string) {
  requirePermission(ctx, "subscribers.write");
  const account = await ensureAccount(ctx, subscriberId);
  if (account.status === "DISABLED") throw new AppError("INVALID_STATE", "Portal access is disabled for this subscriber. Enable it first.");
  const token = await mintInviteToken(account.id);
  await audit(ctx, { action: "portal.invite_link_created", entityType: "subscriber", entityId: subscriberId });
  return { link: inviteLink(ctx.organization.slug, token), expiresInHours: INVITE_TTL_MS / 3_600_000 };
}

export async function setPortalAccess(ctx: StaffContext, subscriberId: string, enabled: boolean) {
  requirePermission(ctx, "subscribers.write");
  const account = await db.customerAccount.findFirst({ where: { subscriberId, organizationId: ctx.organizationId } });
  if (!account) throw notFound("portal account");
  await db.$transaction(async (tx) => {
    await tx.customerAccount.update({
      where: { id: account.id },
      data: enabled ? { status: account.passwordHash ? "ACTIVE" : "INVITED" } : { status: "DISABLED", inviteTokenHash: null, inviteExpiresAt: null },
    });
    if (!enabled) await tx.customerSession.updateMany({ where: { customerAccountId: account.id, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  await audit(ctx, { action: enabled ? "portal.enabled" : "portal.disabled", entityType: "subscriber", entityId: subscriberId });
}

export async function portalAccessStatus(ctx: StaffContext, subscriberId: string) {
  const a = await db.customerAccount.findFirst({ where: { subscriberId, organizationId: ctx.organizationId }, select: { status: true, lastLoginAt: true, activatedAt: true, inviteExpiresAt: true, loginPhone: true } });
  return a;
}
