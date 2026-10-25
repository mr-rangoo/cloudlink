import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, DEFAULT_ROLES, isPermissionKey } from "@/server/auth/permissions";
import { hasPermission, requirePermission, tenantWhere, type StaffContext } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { NAV_ITEMS } from "@/lib/navigation";

const role = (key: string) => DEFAULT_ROLES.find((r) => r.key === key)!;

function ctxWith(permissions: string[], branchIds: string[] | null = null): StaffContext {
  return {
    kind: "staff",
    correlationId: "test-correlation",
    ipAddress: null,
    userAgent: null,
    sessionId: "s",
    userId: "u",
    userName: "Test",
    email: "t@example.com",
    organization: { id: "org-1", name: "Org", slug: "org", currency: "KES", timezone: "Africa/Nairobi" },
    organizationId: "org-1",
    membershipId: "m",
    roles: [],
    permissions: new Set(permissions.filter(isPermissionKey)),
    branchIds,
    activeBranchId: null,
  };
}

describe("default roles", () => {
  it("only reference catalogued permissions", () => {
    for (const r of DEFAULT_ROLES) for (const p of r.permissions) expect(isPermissionKey(p), `${r.key}:${p}`).toBe(true);
  });

  it("gives the owner every permission", () => {
    expect(new Set(role("owner").permissions)).toEqual(new Set(ALL_PERMISSIONS));
  });

  it("keeps high-risk permissions away from front-line roles", () => {
    expect(role("cashier").permissions).not.toContain("payments.refund");
    expect(role("cashier").permissions).not.toContain("network.operate");
    expect(role("support").permissions).not.toContain("network.operate");
    expect(role("support").permissions).not.toContain("payments.refund");
    expect(role("sales").permissions).not.toContain("payments.record");
    expect(role("technician").permissions).toContain("network.operate");
    expect(role("accountant").permissions).toContain("payments.refund");
    expect(role("auditor").permissions.every((p) => p.endsWith(".read") || p === "dashboard.view")).toBe(true);
  });

  it("navigation only references catalogued permissions", () => {
    for (const item of NAV_ITEMS) expect(isPermissionKey(item.permission), item.slug).toBe(true);
  });
});

describe("authorization helpers", () => {
  it("requirePermission throws FORBIDDEN for missing permissions", () => {
    const ctx = ctxWith(["payments.read"]);
    expect(hasPermission(ctx, "payments.read")).toBe(true);
    expect(() => requirePermission(ctx, "payments.refund")).toThrow(AppError);
    try {
      requirePermission(ctx, "payments.read", "payments.refund");
    } catch (err) {
      expect((err as AppError).code).toBe("FORBIDDEN");
      expect((err as AppError).status).toBe(403);
    }
  });

  it("tenantWhere scopes by organization and restricted branches", () => {
    expect(tenantWhere(ctxWith([]))).toEqual({ organizationId: "org-1" });
    expect(tenantWhere(ctxWith([], ["b1", "b2"]))).toEqual({ organizationId: "org-1", branchId: { in: ["b1", "b2"] } });
  });
});
