import { staffRoute, uuidParam } from "@/server/api/handler";
import { invoicePdf, pdfResponse } from "@/server/services/documents";

export const runtime = "nodejs";

export const GET = staffRoute({ permission: "invoices.read", params: uuidParam }, async ({ ctx, params, req }) => {
  const { pdf, filename } = await invoicePdf(ctx, params.id);
  return pdfResponse(pdf, filename, req.nextUrl.searchParams.get("download") !== "1");
});
