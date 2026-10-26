import { customerRoute } from "@/server/api/handler";
import { customerConnection } from "@/server/portal/services";

export const GET = customerRoute({}, async ({ ctx }) => ({ data: await customerConnection(ctx) }));
