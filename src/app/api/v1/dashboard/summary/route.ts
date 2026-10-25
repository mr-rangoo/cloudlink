import { staffRoute } from "@/server/api/handler";
import { dashboardSummary } from "@/server/services/dashboard";

export const GET = staffRoute({ permission: "dashboard.view" }, async ({ ctx }) => ({ data: await dashboardSummary(ctx) }));
