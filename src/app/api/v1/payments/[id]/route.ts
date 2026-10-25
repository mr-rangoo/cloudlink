import { staffRoute, uuidParam } from "@/server/api/handler";
import { getPayment } from "@/server/services/payments";

export const GET = staffRoute({ permission: "payments.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getPayment(ctx, params.id) }));
