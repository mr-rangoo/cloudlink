import { staffRoute, uuidParam } from "@/server/api/handler";
import { deleteDraftInvoice, getInvoice } from "@/server/services/invoices";

export const GET = staffRoute({ permission: "invoices.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getInvoice(ctx, params.id) }));

/** Only drafts can be deleted; issued invoices are voided instead. */
export const DELETE = staffRoute({ permission: "invoices.write", params: uuidParam }, async ({ ctx, params }) => {
  await deleteDraftInvoice(ctx, params.id);
  return { data: { deleted: true } };
});
