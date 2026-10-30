import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit, auditAnonymous } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { ALL_PERMISSIONS, isPermissionKey, PERMISSIONS, type PermissionKey } from "@/server/auth/permissions";
import { hashPassword, PASSWORD_MIN_LENGTH, randomToken, sha256 } from "@/server/security/crypto";
import { revokeAllUserSessions } from "@/server/auth/session";
import { normalizeEmail } from "@/server/auth/service";
import { getBillingSettings } from "@/server/services/invoices";
import type { Prisma } from "@/generated/prisma/client";

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
/** Placeholder hash for invited users: never verifies, so they cannot sign in until they set a password. */
const UNUSABLE_PASSWORD = "invited$not-set";

// ───────── Staff ─────────

export const staffInviteInput = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(254),
  roleIds: z.array(z.uuid()).min(1).max(10),
  branchIds: z.array(z.uuid()).max(50).nullable().default(null), // null = all branches
});

export const staffUpdateInput = z.object({
  roleIds: z.array(z.uuid()).min(1).max(10).optional(),
  branchIds: z.array(z.uuid()).max(50).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const setPasswordInput = z.object({ token: z.string().min(20).max(128), password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`).max(256) });

function setupLink(token: string) {
  return `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`;
}

async function mintStaffInvite(organizationId: string, userId: string, purpose: "setup" | "reset", createdById: string) {
  const token = randomToken(32);
  await db.$transaction(async (tx) => {
    await tx.staffInvite.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }); // invalidate older links
    await tx.staffInvite.create({ data: { organizationId, userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), createdById } });
  });
  return token;
}

async function validateRolesAndBranches(ctx: StaffContext, roleIds: string[] | undefined, branchIds: string[] | null | undefined) {
  if (roleIds) {
    const roles = await db.role.findMany({ where: { id: { in: roleIds }, organizationId: ctx.organizationId }, select: { id: true, key: true } });
    if (roles.length !== new Set(roleIds).size) throw new AppError("VALIDATION_ERROR", "One or more roles are invalid.", { fields: [{ path: "roleIds", message: "Invalid role" }] });
    if (roles.some((r) => r.key === "owner") && !ctx.roles.includes("owner")) throw new AppError("FORBIDDEN", "Only owners can grant the owner role.");
  }
  if (branchIds) {
    const n = await db.branch.count({ where: { id: { in: branchIds }, organizationId: ctx.organizationId } });
    if (n !== new Set(branchIds).size) throw new AppError("VALIDATION_ERROR", "One or more branches are invalid.", { fields: [{ path: "branchIds", message: "Invalid branch" }] });
    if (ctx.branchIds && branchIds.some((b) => !ctx.branchIds!.includes(b))) throw new AppError("FORBIDDEN", "You cannot grant access to branches outside your own scope.");
  }
  if (branchIds === null && ctx.branchIds) throw new AppError("FORBIDDEN", "Branch-restricted administrators cannot grant all-branch access.");
}

export async function listStaff(ctx: StaffContext) {
  requirePermission(ctx, "staff.read");
  const members = await db.membership.findMany({
    where: { organizationId: ctx.organizationId },
    include: { user: { select: { id: true, name: true, email: true, status: true, lastLoginAt: true, passwordHash: true } }, roles: { include: { role: { select: { id: true, key: true, name: true } } } }, branches: { select: { branchId: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });
  return members.map((m) => ({
    membershipId: m.id,
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    status: m.status,
    userStatus: m.user.status,
    pendingSetup: m.user.passwordHash === UNUSABLE_PASSWORD,
    lastLoginAt: m.user.lastLoginAt,
    roles: m.roles.map((r) => r.role),
    allBranches: m.allBranches,
    branchIds: m.branches.map((b) => b.branchId),
  }));
}

/** Invite a staff member. New users get a setup link (shown once); existing users simply join this organization. */
export async function inviteStaff(ctx: StaffContext, input: z.infer<typeof staffInviteInput>) {
  requirePermission(ctx, "staff.write");
  await validateRolesAndBranches(ctx, input.roleIds, input.branchIds);
  const email = normalizeEmail(input.email);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing?.kind === "CUSTOMER") throw new AppError("CONFLICT", "This email belongs to a customer account.");
  if (existing && (await db.membership.findUnique({ where: { organizationId_userId: { organizationId: ctx.organizationId, userId: existing.id } } }))) {
    throw new AppError("CONFLICT", "This person is already a staff member of this organization.");
  }
  const user = await db.$transaction(async (tx) => {
    const u = existing ?? (await tx.user.create({ data: { name: input.name, email, passwordHash: UNUSABLE_PASSWORD, kind: "STAFF" } }));
    const m = await tx.membership.create({ data: { organizationId: ctx.organizationId, userId: u.id, allBranches: input.branchIds === null } });
    await tx.membershipRole.createMany({ data: input.roleIds.map((roleId) => ({ membershipId: m.id, roleId })) });
    if (input.branchIds) await tx.membershipBranch.createMany({ data: input.branchIds.map((branchId) => ({ membershipId: m.id, branchId })) });
    return u;
  });
  const link = existing ? null : setupLink(await mintStaffInvite(ctx.organizationId, user.id, "setup", ctx.userId));
  await audit(ctx, { action: "staff.invite", entityType: "user", entityId: user.id, metadata: { email, roles: input.roleIds, existingUser: Boolean(existing) } });
  return { userId: user.id, setupLink: link, existingUser: Boolean(existing) };
}

async function ownerCount(organizationId: string, excludeMembershipId?: string) {
  return db.membership.count({ where: { organizationId, status: "ACTIVE", id: excludeMembershipId ? { not: excludeMembershipId } : undefined, roles: { some: { role: { key: "owner" } } }, user: { status: "ACTIVE" } } });
}

export async function updateStaff(ctx: StaffContext, membershipId: string, input: z.infer<typeof staffUpdateInput>) {
  requirePermission(ctx, "staff.write");
  const m = await db.membership.findFirst({ where: { id: membershipId, organizationId: ctx.organizationId }, include: { roles: { include: { role: true } } } });
  if (!m) throw notFound("staff member");
  if (m.userId === ctx.userId && (input.status === "INACTIVE" || input.roleIds)) throw new AppError("INVALID_STATE", "You cannot change your own roles or deactivate yourself.");
  const isOwner = m.roles.some((r) => r.role.key === "owner");
  if (isOwner && !ctx.roles.includes("owner")) throw new AppError("FORBIDDEN", "Only owners can change another owner.");
  await validateRolesAndBranches(ctx, input.roleIds, input.branchIds);
  const losingOwner = isOwner && (input.status === "INACTIVE" || (input.roleIds && !(await db.role.findMany({ where: { id: { in: input.roleIds } } })).some((r) => r.key === "owner")));
  if (losingOwner && (await ownerCount(ctx.organizationId, membershipId)) === 0) throw new AppError("INVALID_STATE", "An organization must keep at least one active owner.");

  await db.$transaction(async (tx) => {
    if (input.roleIds) {
      await tx.membershipRole.deleteMany({ where: { membershipId } });
      await tx.membershipRole.createMany({ data: input.roleIds.map((roleId) => ({ membershipId, roleId })) });
    }
    if (input.branchIds !== undefined) {
      await tx.membershipBranch.deleteMany({ where: { membershipId } });
      if (input.branchIds) await tx.membershipBranch.createMany({ data: input.branchIds.map((branchId) => ({ membershipId, branchId })) });
      await tx.membership.update({ where: { id: membershipId }, data: { allBranches: input.branchIds === null } });
    }
    if (input.status) await tx.membership.update({ where: { id: membershipId }, data: { status: input.status } });
    // Material permission changes revoke this person's sessions in this organization.
    if (input.status === "INACTIVE" || input.roleIds || input.branchIds !== undefined) {
      await tx.session.updateMany({ where: { userId: m.userId, organizationId: ctx.organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
  });
  await audit(ctx, { action: "staff.update", entityType: "user", entityId: m.userId, metadata: { ...input, previousRoles: m.roles.map((r) => r.role.key) } });
}

/** Admin-initiated password reset: returns a single-use link (shown once). Existing sessions are revoked on use. */
export async function createStaffResetLink(ctx: StaffContext, membershipId: string) {
  requirePermission(ctx, "staff.write");
  const m = await db.membership.findFirst({ where: { id: membershipId, organizationId: ctx.organizationId }, include: { roles: { include: { role: true } } } });
  if (!m) throw notFound("staff member");
  if (m.roles.some((r) => r.role.key === "owner") && !ctx.roles.includes("owner")) throw new AppError("FORBIDDEN", "Only owners can reset another owner's password.");
  const token = await mintStaffInvite(ctx.organizationId, m.userId, "reset", ctx.userId);
  await audit(ctx, { action: "staff.reset_link", entityType: "user", entityId: m.userId });
  return { link: setupLink(token), expiresInHours: INVITE_TTL_MS / 3_600_000 };
}

export async function describeStaffInvite(token: string) {
  const inv = await db.staffInvite.findUnique({ where: { tokenHash: sha256(token) } });
  if (!inv || inv.usedAt || inv.expiresAt < new Date()) return null;
  const [user, org] = await Promise.all([db.user.findUnique({ where: { id: inv.userId }, select: { name: true, email: true } }), db.organization.findUnique({ where: { id: inv.organizationId }, select: { name: true } })]);
  return user && org ? { name: user.name, email: user.email, organization: org.name, purpose: inv.purpose } : null;
}

export async function completeStaffInvite(input: z.infer<typeof setPasswordInput>, meta: { ipAddress: string | null; userAgent: string | null; correlationId: string }) {
  const inv = await db.staffInvite.findUnique({ where: { tokenHash: sha256(input.token) } });
  if (!inv || inv.usedAt || inv.expiresAt < new Date()) throw new AppError("VALIDATION_ERROR", "This link is invalid or has expired. Ask an administrator for a new one.");
  const passwordHash = await hashPassword(input.password);
  await db.$transaction(async (tx) => {
    const claimed = await tx.staffInvite.updateMany({ where: { id: inv.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError("CONFLICT", "This link has already been used.");
    await tx.user.update({ where: { id: inv.userId }, data: { passwordHash, failedLogins: 0, lockedUntil: null } });
  });
  await revokeAllUserSessions(inv.userId);
  await auditAnonymous({ action: inv.purpose === "setup" ? "staff.setup_completed" : "staff.password_reset", organizationId: inv.organizationId, actorUserId: inv.userId, entityType: "user", entityId: inv.userId, ...meta });
}

// ───────── Roles ─────────

export const roleInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional().nullable(),
  permissions: z.array(z.string()).max(ALL_PERMISSIONS.length).refine((ps) => ps.every(isPermissionKey), "Unknown permission"),
});

export async function listRoles(ctx: StaffContext) {
  requirePermission(ctx, "staff.read");
  const roles = await db.role.findMany({ where: { organizationId: ctx.organizationId }, include: { permissions: true, _count: { select: { memberships: true } } }, orderBy: { createdAt: "asc" } });
  return {
    catalogue: ALL_PERMISSIONS.map((key) => ({ key, description: PERMISSIONS[key] })),
    roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, locked: r.key === "owner", members: r._count.memberships, permissions: r.permissions.map((p) => p.permissionKey).sort() })),
  };
}

export async function updateRole(ctx: StaffContext, roleId: string, input: z.infer<typeof roleInput>) {
  requirePermission(ctx, "roles.write");
  const role = await db.role.findFirst({ where: { id: roleId, organizationId: ctx.organizationId }, include: { permissions: true } });
  if (!role) throw notFound("role");
  if (role.key === "owner") throw new AppError("INVALID_STATE", "The owner role always has every permission and cannot be edited.");
  const next = [...new Set(input.permissions)] as PermissionKey[];
  if (ctx.roles.includes(role.key) && !next.includes("roles.write") && !ctx.roles.includes("owner")) {
    throw new AppError("INVALID_STATE", "You cannot remove role management from a role you hold.");
  }
  const before = role.permissions.map((p) => p.permissionKey).sort();
  await db.$transaction(async (tx) => {
    await tx.role.update({ where: { id: roleId }, data: { name: input.name, description: input.description ?? null } });
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (next.length) await tx.rolePermission.createMany({ data: next.map((permissionKey) => ({ roleId, permissionKey })) });
  });
  const added = next.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !next.includes(p as PermissionKey));
  await audit(ctx, { action: "role.update", entityType: "role", entityId: roleId, metadata: { key: role.key, added, removed } });
  return { added, removed };
}

export async function createRole(ctx: StaffContext, input: z.infer<typeof roleInput>) {
  requirePermission(ctx, "roles.write");
  const key = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "custom";
  if (await db.role.findUnique({ where: { organizationId_key: { organizationId: ctx.organizationId, key } } })) throw new AppError("CONFLICT", "A role with this name already exists.");
  const role = await db.role.create({
    data: { organizationId: ctx.organizationId, key, name: input.name, description: input.description ?? null, isSystem: false, permissions: { create: [...new Set(input.permissions)].map((permissionKey) => ({ permissionKey })) } },
  });
  await audit(ctx, { action: "role.create", entityType: "role", entityId: role.id, metadata: { key, permissions: input.permissions } });
  return role;
}

export async function deleteRole(ctx: StaffContext, roleId: string) {
  requirePermission(ctx, "roles.write");
  const role = await db.role.findFirst({ where: { id: roleId, organizationId: ctx.organizationId }, include: { _count: { select: { memberships: true } } } });
  if (!role) throw notFound("role");
  if (role.isSystem) throw new AppError("INVALID_STATE", "Built-in roles cannot be deleted; edit their permissions instead.");
  if (role._count.memberships) throw new AppError("INVALID_STATE", "Remove this role from all staff before deleting it.");
  await db.role.delete({ where: { id: roleId } });
  await audit(ctx, { action: "role.delete", entityType: "role", entityId: roleId, metadata: { key: role.key } });
}

// ───────── Branches ─────────

export const branchInput = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,16}$/, "Use 2–16 letters or digits"),
  address: z.string().trim().max(300).optional().nullable(),
});
export const branchUpdateInput = branchInput.partial().extend({ status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional() });

export async function listBranches(ctx: StaffContext) {
  requirePermission(ctx, "branches.read");
  const branches = await db.branch.findMany({ where: { organizationId: ctx.organizationId, ...(ctx.branchIds ? { id: { in: ctx.branchIds } } : {}) }, orderBy: [{ status: "asc" }, { name: "asc" }] });
  const counts = await db.subscriber.groupBy({ by: ["branchId"], where: { organizationId: ctx.organizationId, status: { not: "ARCHIVED" } }, _count: { _all: true } });
  return branches.map((b) => ({ ...b, subscribers: counts.find((c) => c.branchId === b.id)?._count._all ?? 0 }));
}

export async function createBranch(ctx: StaffContext, raw: z.input<typeof branchInput>) {
  requirePermission(ctx, "branches.write");
  const input = branchInput.parse(raw); // normalise even when called outside the API layer
  if (ctx.branchIds) throw new AppError("FORBIDDEN", "Branch-restricted staff cannot create branches.");
  const b = await db.branch.create({ data: { organizationId: ctx.organizationId, name: input.name, code: input.code, address: input.address ?? null } });
  await audit(ctx, { action: "branch.create", entityType: "branch", entityId: b.id, metadata: { code: b.code } });
  return b;
}

export async function updateBranch(ctx: StaffContext, id: string, raw: z.input<typeof branchUpdateInput>) {
  requirePermission(ctx, "branches.write");
  const input = branchUpdateInput.parse(raw);
  const b = await db.branch.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!b || (ctx.branchIds && !ctx.branchIds.includes(id))) throw notFound("branch");
  if (input.status === "ARCHIVED") {
    const live = await db.subscriber.count({ where: { branchId: id, status: { not: "ARCHIVED" } } });
    if (live) throw new AppError("INVALID_STATE", `Move the ${live} subscriber(s) in this branch before archiving it.`);
  }
  const updated = await db.branch.update({ where: { id }, data: { ...input, address: input.address === undefined ? undefined : (input.address ?? null) } });
  await audit(ctx, { action: "branch.update", entityType: "branch", entityId: id, metadata: input });
  return updated;
}

// ───────── Organization & billing settings ─────────

export const TIMEZONES = ["Africa/Nairobi", "Africa/Kampala", "Africa/Dar_es_Salaam", "Africa/Kigali", "Africa/Lagos", "Africa/Johannesburg", "UTC"] as const;

export const settingsInput = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  timezone: z.enum(TIMEZONES).optional(),
  billing: z
    .object({
      legalName: z.string().trim().max(160).nullable().optional(),
      address: z.string().trim().max(300).nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      email: z.string().trim().max(160).nullable().optional(),
      taxPin: z.string().trim().max(40).nullable().optional(),
      taxLabel: z.string().trim().min(1).max(20).optional(),
      invoicePrefix: z.string().trim().regex(/^[A-Z]{2,6}$/, "2–6 capital letters").optional(),
      receiptPrefix: z.string().trim().regex(/^[A-Z]{2,6}$/, "2–6 capital letters").optional(),
      creditNotePrefix: z.string().trim().regex(/^[A-Z]{2,6}$/, "2–6 capital letters").optional(),
      invoiceLeadDays: z.coerce.number().int().min(0).max(60).optional(),
      expiryReminderDays: z.coerce.number().int().min(0).max(30).optional(),
      paymentTermsDays: z.coerce.number().int().min(0).max(120).optional(),
      invoiceOnActivation: z.boolean().optional(),
      invoiceFooter: z.string().trim().max(300).nullable().optional(),
    })
    .optional(),
});

export async function getSettings(ctx: StaffContext) {
  requirePermission(ctx, "settings.write");
  const [org, billing, invoiceCount] = await Promise.all([db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }), getBillingSettings(db, ctx.organizationId), db.invoice.count({ where: { organizationId: ctx.organizationId } })]);
  return { organization: { name: org.name, slug: org.slug, currency: org.currency, timezone: org.timezone, currencyLocked: invoiceCount > 0 }, billing, timezones: TIMEZONES };
}

export async function updateSettings(ctx: StaffContext, input: z.infer<typeof settingsInput>) {
  requirePermission(ctx, "settings.write");
  const before = await getSettings(ctx);
  await db.$transaction(async (tx) => {
    if (input.name || input.timezone) await tx.organization.update({ where: { id: ctx.organizationId }, data: { name: input.name, timezone: input.timezone } });
    if (input.billing) await tx.billingSettings.update({ where: { organizationId: ctx.organizationId }, data: input.billing as Prisma.BillingSettingsUpdateInput });
  });
  await audit(ctx, { action: "settings.update", entityType: "organization", entityId: ctx.organizationId, metadata: { changed: input, previousTimezone: before.organization.timezone } });
  return getSettings(ctx);
}

// ───────── Audit log search ─────────

export const auditQuery = z.object({
  action: z.string().trim().max(80).optional(),
  actor: z.uuid().optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export async function searchAuditLogs(ctx: StaffContext, q: z.infer<typeof auditQuery>) {
  requirePermission(ctx, "audit.read");
  const where: Prisma.AuditLogWhereInput = {
    organizationId: ctx.organizationId,
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.actor ? { actorUserId: q.actor } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }), db.auditLog.count({ where })]);
  const users = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v)) } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
  return { rows: rows.map((r) => ({ ...r, actor: r.actorUserId ? (users.get(r.actorUserId) ?? null) : null })), total };
}
