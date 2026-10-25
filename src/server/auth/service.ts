import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { getDummyHash, verifyPassword } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS, resetRateLimit } from "@/server/security/rate-limit";
import { auditAnonymous, audit } from "@/server/audit/audit";
import { createSession, revokeSession } from "@/server/auth/session";
import type { RequestMeta, StaffContext } from "@/server/auth/context";

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(256),
});

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const invalidCredentials = () => new AppError("UNAUTHENTICATED", "The email or password is incorrect, or the account is unavailable.");

/**
 * Staff login. Error messages are deliberately generic so they do not reveal whether an
 * account exists, is disabled or is locked. Failures are audited and throttled.
 */
export async function loginStaff(input: z.infer<typeof loginSchema>, meta: RequestMeta) {
  const email = normalizeEmail(input.email);
  await consumeRateLimit(RATE_LIMITS.loginByIp, meta.ipAddress ?? "unknown");
  await consumeRateLimit(RATE_LIMITS.loginByEmail, email);

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    await verifyPassword(input.password, await getDummyHash());
    await auditAnonymous({ action: "auth.login_failed", metadata: { reason: "unknown_user" }, ...meta });
    throw invalidCredentials();
  }

  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    await auditAnonymous({ action: "auth.login_failed", actorUserId: user.id, metadata: { reason: "locked" }, ...meta });
    throw invalidCredentials();
  }

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await db.user.update({
      where: { id: user.id },
      data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) : user.lockedUntil },
    });
    await auditAnonymous({ action: lock ? "auth.account_locked" : "auth.login_failed", actorUserId: user.id, metadata: { reason: "bad_password" }, ...meta });
    throw invalidCredentials();
  }

  if (user.status !== "ACTIVE" || user.kind !== "STAFF") {
    await auditAnonymous({ action: "auth.login_failed", actorUserId: user.id, metadata: { reason: user.status !== "ACTIVE" ? "disabled" : "not_staff" }, ...meta });
    throw invalidCredentials();
  }

  const membership = await db.membership.findFirst({
    where: { userId: user.id, status: "ACTIVE", organization: { status: "ACTIVE" } },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) {
    await auditAnonymous({ action: "auth.login_failed", actorUserId: user.id, metadata: { reason: "no_active_membership" }, ...meta });
    throw invalidCredentials();
  }

  await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
  await resetRateLimit(RATE_LIMITS.loginByEmail, email);
  const session = await createSession(user.id, membership.organizationId, meta);
  await auditAnonymous({
    action: "auth.login",
    organizationId: membership.organizationId,
    actorUserId: user.id,
    entityType: "session",
    entityId: session.sessionId,
    ...meta,
  });
  return session;
}

export async function logout(ctx: StaffContext): Promise<void> {
  await revokeSession(ctx.sessionId);
  await audit(ctx, { action: "auth.logout", entityType: "session", entityId: ctx.sessionId });
}

/** Switch the active organization for the current session. Membership is re-verified server-side. */
export async function switchOrganization(ctx: StaffContext, organizationId: string): Promise<void> {
  const membership = await db.membership.findFirst({
    where: { userId: ctx.userId, organizationId, status: "ACTIVE", organization: { status: "ACTIVE" } },
  });
  if (!membership) throw new AppError("FORBIDDEN", "You do not have access to that organization.");
  await db.session.update({ where: { id: ctx.sessionId }, data: { organizationId, activeBranchId: null } });
  await auditAnonymous({
    action: "auth.switch_organization",
    organizationId,
    actorUserId: ctx.userId,
    metadata: { from: ctx.organizationId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });
}

/** Set (or clear) the active branch filter. The branch must be within the member's scope. */
export async function switchBranch(ctx: StaffContext, branchId: string | null): Promise<void> {
  if (branchId) {
    if (ctx.branchIds && !ctx.branchIds.includes(branchId)) throw new AppError("FORBIDDEN", "You do not have access to this branch.");
    const branch = await db.branch.findFirst({ where: { id: branchId, organizationId: ctx.organizationId, status: { not: "ARCHIVED" } } });
    if (!branch) throw new AppError("NOT_FOUND", "The requested branch was not found.");
  }
  await db.session.update({ where: { id: ctx.sessionId }, data: { activeBranchId: branchId } });
}

export async function listUserOrganizations(userId: string) {
  const memberships = await db.membership.findMany({
    where: { userId, status: "ACTIVE", organization: { status: "ACTIVE" } },
    include: { organization: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => m.organization);
}

export async function listAccessibleBranches(ctx: StaffContext) {
  return db.branch.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: { not: "ARCHIVED" },
      ...(ctx.branchIds ? { id: { in: ctx.branchIds } } : {}),
    },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });
}
