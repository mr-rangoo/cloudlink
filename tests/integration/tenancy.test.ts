import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { assertBranchAccess, tenantWhere } from "@/server/auth/context";
import { switchBranch, switchOrganization, listAccessibleBranches } from "@/server/auth/service";
import { GET as sessionGet, PATCH as sessionPatch } from "@/app/api/v1/auth/session/route";
import { contextFor, createOrg, createStaff, noParams, request, sessionFor } from "./fixtures";

describe("organization and branch isolation", () => {
  it("bootstraps an organization with default roles, a branch and an owner", async () => {
    const { organization, branch, owner } = await createOrg();
    expect(organization.currency).toBe("KES");
    expect(organization.timezone).toBe("Africa/Nairobi");
    expect(branch.organizationId).toBe(organization.id);
    expect(await db.role.count({ where: { organizationId: organization.id } })).toBeGreaterThanOrEqual(7);
    const ctx = await contextFor(owner.id, organization.id);
    expect(ctx.roles).toEqual(["owner"]);
    expect(ctx.permissions.has("roles.write")).toBe(true);
    expect(ctx.branchIds).toBeNull();
  });

  it("prevents a member of one organization from switching into another", async () => {
    const a = await createOrg("Alpha");
    const b = await createOrg("Bravo");
    const ctxA = await contextFor(a.owner.id, a.organization.id);
    await expect(switchOrganization(ctxA, b.organization.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertBranchAccess(ctxA, b.branch.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets a multi-organization member switch only between their organizations", async () => {
    const a = await createOrg("Alpha");
    const b = await createOrg("Bravo");
    const roles = await db.role.findFirstOrThrow({ where: { organizationId: b.organization.id, key: "support" } });
    const m = await db.membership.create({ data: { organizationId: b.organization.id, userId: a.owner.id } });
    await db.membershipRole.create({ data: { membershipId: m.id, roleId: roles.id } });

    const token = await sessionFor(a.owner.id, a.organization.id);
    const res = await sessionPatch(request("/api/v1/auth/session", { method: "PATCH", token, body: { organizationId: b.organization.id } }), noParams);
    expect(res.status).toBe(200);
    const me = await (await sessionGet(request("/api/v1/auth/session", { token }), noParams)).json();
    expect(me.data.organization.id).toBe(b.organization.id);
    expect(me.data.roles).toEqual(["support"]); // permissions are re-resolved for the new organization
    expect(me.data.permissions).not.toContain("roles.write");
  });

  it("restricts branch-scoped staff to their branches", async () => {
    const { organization, branch: main } = await createOrg();
    const other = await db.branch.create({ data: { organizationId: organization.id, name: "Other", code: "OTH" } });
    const { user } = await createStaff(organization.id, "cashier", { branchIds: [other.id] });
    const ctx = await contextFor(user.id, organization.id);

    expect(ctx.branchIds).toEqual([other.id]);
    expect(tenantWhere(ctx)).toEqual({ organizationId: organization.id, branchId: { in: [other.id] } });
    await expect(assertBranchAccess(ctx, other.id)).resolves.toBeUndefined();
    await expect(assertBranchAccess(ctx, main.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertBranchAccess(ctx, null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(switchBranch(ctx, main.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listAccessibleBranches(ctx)).map((b) => b.id)).toEqual([other.id]);
  });

  it("denies access when the membership is deactivated", async () => {
    const { organization } = await createOrg();
    const { user, membership } = await createStaff(organization.id, "support");
    const token = await sessionFor(user.id, organization.id);
    await db.membership.update({ where: { id: membership.id }, data: { status: "INACTIVE" } });
    const res = await sessionGet(request("/api/v1/auth/session", { token }), noParams);
    expect(res.status).toBe(403);
  });
});
