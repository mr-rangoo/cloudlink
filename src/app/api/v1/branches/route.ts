import { staffRoute } from "@/server/api/handler";
import { branchInput, createBranch, listBranches } from "@/server/services/admin";

export const GET = staffRoute({ permission: "branches.read" }, async ({ ctx }) => ({ data: await listBranches(ctx) }));
export const POST = staffRoute({ permission: "branches.write", body: branchInput }, async ({ ctx, body }) => ({ data: await createBranch(ctx, body), status: 201 }));
