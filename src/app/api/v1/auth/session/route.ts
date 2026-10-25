import { z } from "zod";
import { staffRoute } from "@/server/api/handler";
import { listAccessibleBranches, listUserOrganizations, switchBranch, switchOrganization } from "@/server/auth/service";

/** Current session: user, active organization, permissions and accessible branches. */
export const GET = staffRoute({}, async ({ ctx }) => {
  const [organizations, branches] = await Promise.all([listUserOrganizations(ctx.userId), listAccessibleBranches(ctx)]);
  return {
    data: {
      user: { id: ctx.userId, name: ctx.userName, email: ctx.email },
      organization: ctx.organization,
      roles: ctx.roles,
      permissions: [...ctx.permissions].sort(),
      branchScope: ctx.branchIds === null ? "all" : "restricted",
      activeBranchId: ctx.activeBranchId,
      organizations,
      branches,
    },
  };
});

const switchSchema = z
  .object({ organizationId: z.uuid().optional(), branchId: z.uuid().nullable().optional() })
  .refine((v) => v.organizationId !== undefined || v.branchId !== undefined, { message: "organizationId or branchId is required" });

/** Switch active organization and/or branch filter. */
export const PATCH = staffRoute({ body: switchSchema }, async ({ ctx, body }) => {
  if (body.organizationId && body.organizationId !== ctx.organizationId) {
    await switchOrganization(ctx, body.organizationId);
    return { data: { ok: true } };
  }
  if (body.branchId !== undefined) await switchBranch(ctx, body.branchId);
  return { data: { ok: true } };
});
