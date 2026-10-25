import { customerRoute, uuidParam } from "@/server/api/handler";
import { getCustomerInvoice } from "@/server/portal/services";

export const GET = customerRoute({ params: uuidParam }, async ({ ctx, params }) => ({ data: await getCustomerInvoice(ctx, params.id) }));
