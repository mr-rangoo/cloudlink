import { customerRoute } from "@/server/api/handler";
import { customerOverview } from "@/server/portal/services";

export const GET = customerRoute({}, async ({ ctx }) => ({ data: { organization: ctx.organization, ...(await customerOverview(ctx)) } }));
