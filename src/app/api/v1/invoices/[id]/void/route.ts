import { staffRoute, uuidParam } from "@/server/api/handler";
import { voidInput, voidInvoice } from "@/server/services/invoices";

export const POST = staffRoute({ permission: "invoices.issue", params: uuidParam, body: voidInput }, async ({ ctx, params, body }) => ({ data: await voidInvoice(ctx, params.id, body.reason) }));
