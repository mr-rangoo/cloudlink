import { staffRoute, uuidParam } from "@/server/api/handler";
import { branchUpdateInput, updateBranch } from "@/server/services/admin";

export const PATCH = staffRoute({ permission: "branches.write", params: uuidParam, body: branchUpdateInput }, async ({ ctx, params, body }) => ({ data: await updateBranch(ctx, params.id, body) }));
