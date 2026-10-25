import { customerRoute } from "@/server/api/handler";
import { listCustomerInvoices } from "@/server/portal/services";

export const GET = customerRoute({}, async ({ ctx }) => ({ data: await listCustomerInvoices(ctx) }));
