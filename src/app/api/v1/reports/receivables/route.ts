import { staffRoute } from "@/server/api/handler";
import { receivablesAging } from "@/server/services/reports";

export const GET = staffRoute({ permission: "reports.read" }, async ({ ctx }) => ({ data: await receivablesAging(ctx) }));
