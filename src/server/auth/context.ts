import "server-only";
import { db } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { isPermissionKey, type PermissionKey } from "@/server/auth/permissions";
import type { ResolvedSession } from "@/server/auth/session";

export interface RequestMeta {
  correlationId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
}

/** Authenticated staff context. Every tenant-scoped service takes this as its first argument. */
export interface StaffContext extends RequestMeta {
  kind: "staff";
  sessionId: string;
  userId: string;
  userName: string;
  email: string;
  organization: OrganizationSummary;
  organizationId: string;
  membershipId: string;
  roles: string[];
  permissions: ReadonlySet<PermissionKey>;
  /** null means the member may access every branch in the organization. */
  branchIds: string[] | null;
  activeBranchId: string | null;
}

/** Context for system actors (worker jobs, webhooks). Always bound to one organization. */
export interface SystemContext extends RequestMeta {
  kind: "system";
  organizationId: string;
  actor: string; // e.g. "worker:billing", "webhook:mpesa"
}

/** Customer portal context: always bound to exactly one subscriber. Holds no staff permissions. */
export interface CustomerContext extends RequestMeta {
  kind: "customer";
  organizationId: string;
  organization: OrganizationSummary;
  subscriberId: string;
  customerAccountId: string;
  sessionId: string;
  displayName: string;
}

export type ActorContext = StaffContext | SystemContext | CustomerContext;

export async function loadStaffContext(session: ResolvedSession, meta: RequestMeta): Promise<StaffContext> {
  if (session.user.kind !== "STAFF") throw new AppError("FORBIDDEN");
  if (!session.organizationId) throw new AppError("FORBIDDEN", "No organization is selected for this session.");

  const membership = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId: session.organizationId, userId: session.userId } },
    include: {
      organization: true,
      roles: { include: { role: { include: { permissions: true } } } },
      branches: { include: { branch: { select: { id: true, status: true } } } },
    },
  });
  if (!membership || membership.status !== "ACTIVE" || membership.organization.status !== "ACTIVE") {
    throw new AppError("FORBIDDEN", "Your access to this organization is not active.");
  }

  const permissions = new Set<PermissionKey>();
  for (const mr of membership.roles) {
    for (const rp of mr.role.permissions) if (isPermissionKey(rp.permissionKey)) permissions.add(rp.permissionKey);
  }

  const branchIds = membership.allBranches
    ? null
    : membership.branches.filter((b) => b.branch.status !== "ARCHIVED").map((b) => b.branchId);

  let activeBranchId = session.activeBranchId;
  if (activeBranchId && branchIds && !branchIds.includes(activeBranchId)) activeBranchId = null;

  const org = membership.organization;
  return {
    kind: "staff",
    ...meta,
    sessionId: session.id,
    userId: session.userId,
    userName: session.user.name,
    email: session.user.email,
    organization: { id: org.id, name: org.name, slug: org.slug, currency: org.currency, timezone: org.timezone },
    organizationId: org.id,
    membershipId: membership.id,
    roles: membership.roles.map((r) => r.role.key),
    permissions,
    branchIds,
    activeBranchId,
  };
}

export function hasPermission(ctx: ActorContext, permission: PermissionKey): boolean {
  if (ctx.kind === "system") return true;
  if (ctx.kind === "customer") return false; // customers never hold staff permissions
  return ctx.permissions.has(permission);
}

export function requirePermission(ctx: ActorContext, ...required: PermissionKey[]): void {
  for (const p of required) {
    if (!hasPermission(ctx, p)) {
      throw new AppError("FORBIDDEN", undefined, { details: { missingPermission: p } });
    }
  }
}

// ───────── Tenant & branch scoping helpers ─────────

/**
 * Prisma `where` fragment restricting to the caller's organization and allowed branches.
 * Branch-restricted members only see records assigned to their branches.
 */
export function tenantWhere(ctx: ActorContext): { organizationId: string; branchId?: { in: string[] } } {
  if (ctx.kind === "customer") throw new AppError("FORBIDDEN"); // portal code scopes by subscriberId explicitly
  if (ctx.kind === "staff" && ctx.branchIds) return { organizationId: ctx.organizationId, branchId: { in: ctx.branchIds } };
  return { organizationId: ctx.organizationId };
}

/**
 * `tenantWhere` plus the user's active branch filter (the branch selector in the top bar).
 * Use for list views; use `tenantWhere` for direct record access by id.
 */
export function listWhere(ctx: ActorContext): { organizationId: string; branchId?: string | { in: string[] } } {
  if (ctx.kind === "staff" && ctx.activeBranchId) return { organizationId: ctx.organizationId, branchId: ctx.activeBranchId };
  return tenantWhere(ctx);
}

/** Resolve the branch for a new record: explicit choice, else the active branch filter; validated against scope. */
export async function resolveBranchForCreate(ctx: ActorContext, branchId: string | null | undefined): Promise<string | null> {
  const chosen = branchId ?? (ctx.kind === "staff" ? ctx.activeBranchId : null) ?? null;
  await assertBranchAccess(ctx, chosen);
  return chosen;
}

/** Assert that a branch belongs to the caller's organization and is within their branch scope. */
export async function assertBranchAccess(ctx: ActorContext, branchId: string | null | undefined): Promise<void> {
  if (!branchId) {
    if (ctx.kind === "staff" && ctx.branchIds) throw new AppError("FORBIDDEN", "A branch within your scope is required.");
    return;
  }
  if (ctx.kind === "staff" && ctx.branchIds && !ctx.branchIds.includes(branchId)) {
    throw new AppError("FORBIDDEN", "You do not have access to this branch.");
  }
  const branch = await db.branch.findFirst({ where: { id: branchId, organizationId: ctx.organizationId }, select: { id: true } });
  if (!branch) throw new AppError("NOT_FOUND", "The requested branch was not found.");
}

export function systemContext(organizationId: string, actor: string, correlationId: string): SystemContext {
  return { kind: "system", organizationId, actor, correlationId, ipAddress: null, userAgent: null };
}
