import { staffRoute } from "@/server/api/handler";
import { staffAlerts } from "@/server/services/alerts";

export const GET = staffRoute({}, async ({ ctx }) => ({ data: await staffAlerts(ctx) }));
