import { staffRoute, uuidParam } from "@/server/api/handler";
import { simulateRouter } from "@/server/services/router-link";

/** Test mode only (mock network adapter, never in production): a simulated router checks in and confirms changes. */
export const POST = staffRoute({ permission: "routers.write", params: uuidParam }, async ({ ctx, params }) => ({ data: await simulateRouter(ctx, params.id) }));
