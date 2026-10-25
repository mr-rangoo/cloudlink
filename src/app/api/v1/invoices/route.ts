import { paginated, staffRoute } from "@/server/api/handler";
import { createManualInvoice, invoiceCreateInput, invoiceListQuery, listInvoices } from "@/server/services/invoices";

export const GET = staffRoute({ permission: "invoices.read", query: invoiceListQuery }, async ({ ctx, query }) => {
  const { rows, total, outstanding } = await listInvoices(ctx, query);
  return { ...paginated(rows, total, query), outstanding };
});

/** Create a manual invoice (draft, or issued immediately when issue=true). */
export const POST = staffRoute({ permission: "invoices.write", body: invoiceCreateInput }, async ({ ctx, body }) => ({ data: await createManualInvoice(ctx, body), status: 201 }));
