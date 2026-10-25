import { staffRoute, uuidParam } from "@/server/api/handler";
import { issueInvoice } from "@/server/services/invoices";

export const POST = staffRoute({ permission: "invoices.issue", params: uuidParam }, async ({ ctx, params }) => ({ data: await issueInvoice(ctx, params.id) }));
