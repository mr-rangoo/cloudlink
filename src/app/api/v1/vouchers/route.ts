import { staffRoute } from "@/server/api/handler";
import { redemptionStats } from "@/server/services/vouchers";

export const GET = staffRoute({ permission: "vouchers.read" }, async ({ ctx }) => ({ data: await redemptionStats(ctx) }));
