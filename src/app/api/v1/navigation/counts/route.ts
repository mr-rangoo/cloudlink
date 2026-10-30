import { staffRoute } from "@/server/api/handler";
import { navigationCounts } from "@/server/services/dashboard";

/** Counts for the sidebar (online sessions, offline routers, open tickets, payments to match); null = not permitted. */
export const GET = staffRoute({}, async ({ ctx }) => ({ data: await navigationCounts(ctx) }));
