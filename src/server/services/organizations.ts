import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { ALL_PERMISSIONS, DEFAULT_ROLES, PERMISSIONS } from "@/server/auth/permissions";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/server/security/crypto";
import { normalizeEmail } from "@/server/auth/service";
import { AppError } from "@/server/errors";
import type { Prisma } from "@/generated/prisma/client";

/** Path segments used by the customer portal, which therefore cannot be organization slugs. */
export const RESERVED_SLUGS = new Set(["home", "invoices", "payments", "tickets", "profile", "logout", "login", "activate", "api", "admin"]);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, "use lowercase letters, numbers and hyphens")
    .refine((v) => !RESERVED_SLUGS.has(v), "this name is reserved"),
  currency: z.string().length(3).default("KES"),
  timezone: z.string().default("Africa/Nairobi"),
  branch: z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().toUpperCase().min(2).max(16) }),
  owner: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.email(),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
  }),
});

/** Ensure the global permission catalogue rows exist (idempotent). */
export async function syncPermissionCatalogue(client: Tx | typeof db = db): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    await client.permission.upsert({ where: { key }, update: { description: PERMISSIONS[key] }, create: { key, description: PERMISSIONS[key] } });
  }
}

/** Create the default role set for an organization (idempotent per role key). */
export async function ensureDefaultRoles(tx: Tx, organizationId: string) {
  const roles: Record<string, string> = {};
  for (const template of DEFAULT_ROLES) {
    const role = await tx.role.upsert({
      where: { organizationId_key: { organizationId, key: template.key } },
      update: {},
      create: { organizationId, key: template.key, name: template.name, description: template.description, isSystem: true },
    });
    const existing = await tx.rolePermission.count({ where: { roleId: role.id } });
    if (existing === 0) {
      await tx.rolePermission.createMany({ data: template.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })) });
    }
    roles[template.key] = role.id;
  }
  return roles;
}

/**
 * Bootstrap a new tenant: organization, first branch, default roles, and the owner account.
 * Runs in one transaction so a failure leaves nothing half-created.
 */
export async function createOrganizationWithOwner(input: z.input<typeof createOrganizationSchema>) {
  const data = createOrganizationSchema.parse(input);
  const passwordHash = await hashPassword(data.owner.password);
  await syncPermissionCatalogue();
  return db.$transaction((tx) => bootstrapOrganizationTx(tx, data, { name: data.owner.name, email: data.owner.email, passwordHash }));
}

/**
 * The organization, first branch, default roles and owner membership, inside the caller's transaction.
 * With `newUserOnly` (self-service sign-up) an existing account with the email is refused, never reused.
 * Call `syncPermissionCatalogue()` first.
 */
export async function bootstrapOrganizationTx(
  tx: Tx,
  data: { name: string; slug: string; currency: string; timezone: string; branch: { name: string; code: string } },
  owner: { name: string; email: string; passwordHash: string; newUserOnly?: boolean },
  audit: { action: string; metadata?: Record<string, unknown> } = { action: "organization.create" },
) {
  const email = normalizeEmail(owner.email);
  if (await tx.organization.findUnique({ where: { slug: data.slug } })) {
    throw new AppError("CONFLICT", "An organization with this slug already exists.");
  }
  let user = await tx.user.findUnique({ where: { email } });
  if (user && owner.newUserOnly) throw new AppError("CONFLICT", "An account with this email already exists. Sign in instead.");
  const org = await tx.organization.create({
    data: { name: data.name, slug: data.slug, currency: data.currency, timezone: data.timezone },
  });
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: data.branch.name, code: data.branch.code } });
  const roles = await ensureDefaultRoles(tx, org.id);

  user ??= await tx.user.create({ data: { name: owner.name, email, passwordHash: owner.passwordHash, kind: "STAFF" } });
  const membership = await tx.membership.create({ data: { organizationId: org.id, userId: user.id, allBranches: true } });
  await tx.membershipRole.create({ data: { membershipId: membership.id, roleId: roles.owner! } });

  await tx.auditLog.create({
    data: { organizationId: org.id, actorType: "system", action: audit.action, entityType: "organization", entityId: org.id, ...(audit.metadata ? { metadata: audit.metadata as Prisma.InputJsonValue } : {}) },
  });
  return { organization: org, branch, owner: user, roles };
}
